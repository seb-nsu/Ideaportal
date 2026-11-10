import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { withSystem, withTenant } from '../db/pool.js';
import { markRoles, requestLocale, requireUser, tenantHandler } from '../http.js';
import { finalize, saveResult, tx, detachedCtx } from '../ai/pipeline.js';
import { runAgent } from '../ai/gateway.js';
import { PROCESS_TEMPLATES, TEMPLATE_INPUTS, applyProposal, processInput, processProposalCall, processProposalSchema, ruleProposal } from '../ai/process.js';
import { badRequest, forbidden, localizeIssues, notFound } from '../lib/errors.js';
import { FEATURES, PLANS, planPrice, planState, type PlanRow } from '../lib/plans.js';
import { settingsSchema } from '../lib/settings.js';
import { todayIn } from '../lib/workdays.js';
import { m, relocalizeAll } from '../i18n/index.js';
import { audit } from '../services/audit.js';
import {
  bookTopup, catalogue, challengeExport, conversionKpis, createInvoice, exportHeader, exportPdf, invoicePdf,
  invoiceView, planView, quotaUsage, requestPlan, setPlan, type InvoiceRow,
} from '../services/billing.js';
import { operatorLog, requireOperator, type Operator } from '../services/operator.js';
import { toCsv } from './misc.js';
import type { Ctx } from '../lib/context.js';

// Packages and billing (R3-05, R3-06, R3-02, R3-39) and the AI proposal for the process (R3-03).
// Workspace endpoints for admins; operator endpoints under /api/operator/billing use the
// operator login of the console (AP-17, services/operator.ts).

const admin = { roles: ['admin' as const] };
const idParam = (req: FastifyRequest) => z.object({ id: z.uuid() }).parse(req.params).id;
const today = () => todayIn('Europe/Berlin');

/** Billing pages of the console: operator roles owner and billing. */
function operatorHandler<T>(fn: (operator: Operator, req: FastifyRequest, reply: FastifyReply) => Promise<T>) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<T> => fn(await requireOperator(req, 'billing'), req, reply);
}

/** Admin handler without an open transaction while a model answers (like aiHandler in routes/ai.ts). */
function adminAiHandler<T>(fn: (ctx: Ctx, req: FastifyRequest) => Promise<T>) {
  return markRoles(async (req: FastifyRequest): Promise<T> => {
    const user = await requireUser(req);
    if (!user.roles.includes('admin')) throw forbidden();
    return fn(await detachedCtx(user.tenantId, user), req);
  }, ['admin']);
}

const planInput = z.object({
  plan: z.enum(PLANS),
  employees: z.number().int().min(1).max(1_000_000).nullable().optional(),
  startsOn: z.iso.date().optional(),
  featureOverrides: z.partialRecord(z.enum(FEATURES), z.boolean()).optional(),
  quotaOverride: z.number().int().min(0).max(10_000).nullable().optional(),
  note: z.string().max(500).optional(),
});

export async function billingRoutes(app: FastifyInstance): Promise<void> {
  // ------------------------------------------------------------ workspace

  // Package, feature switches and trial days for every signed-in person (the interface hides
  // unavailable features with an upgrade hint and shows the trial banner).
  app.get('/api/plan', tenantHandler(async (ctx) => planView(ctx)));

  app.get(
    '/api/billing',
    tenantHandler(async (ctx) => {
      const row = (await ctx.db.query<PlanRow & { requested_plan: string | null; requested_employees: number | null; requested_at: Date | null; offer_sent_at: Date | null }>(
        'SELECT * FROM tenant_plans WHERE tenant_id = $1', [ctx.tenantId],
      )).rows[0];
      const invoices = await ctx.db.query<InvoiceRow>('SELECT * FROM invoices ORDER BY period_start DESC, created_at DESC LIMIT 24');
      const topups = await ctx.db.query<{ period: string; analyses: number; price_eur: number; created_at: Date }>(
        'SELECT period, analyses, price_eur, created_at FROM ai_topups ORDER BY created_at DESC LIMIT 24',
      );
      const p = ctx.plan!;
      return {
        ...planView(ctx),
        employees: p.employees,
        startsOn: p.startsOn,
        priceEur: planPrice(p.plan, p.employees),
        usage: await quotaUsage(ctx.db, p, ctx.today),
        request: row?.requested_plan ? { plan: row.requested_plan, employees: row.requested_employees, at: row.requested_at } : null,
        offer: p.plan === 'challenge' && (p.status === 'ended' || p.readOnly),
        catalogue: catalogue(),
        invoices: invoices.rows.map(invoiceView),
        topups: topups.rows.map((t) => ({ period: t.period, analyses: t.analyses, priceEur: Number(t.price_eur), createdAt: t.created_at })),
      };
    }, admin),
  );

  // Package request by an admin, e.g. after the trial or to take a challenge into an annual licence.
  app.post(
    '/api/billing/request',
    tenantHandler(async (ctx, req) => {
      const body = z.object({ plan: z.enum(PLANS), employees: z.number().int().min(1).max(1_000_000).nullable().default(null) }).parse(req.body);
      await requestPlan(ctx, body.plan, body.employees);
      return { ok: true };
    }, admin),
  );

  app.get(
    '/api/billing/invoices/:id/pdf',
    tenantHandler(async (ctx, req, reply) => {
      const inv = (await ctx.db.query<InvoiceRow>('SELECT * FROM invoices WHERE id = $1', [idParam(req)])).rows[0];
      if (!inv) throw notFound(m('billing.invoiceNotFound'));
      const name = (await ctx.db.query<{ name: string }>('SELECT name FROM tenants WHERE id = $1', [ctx.tenantId])).rows[0].name;
      reply.header('content-disposition', `attachment; filename="${inv.number}.pdf"`).type('application/pdf');
      return invoicePdf(inv, name, ctx.locale);
    }, admin),
  );

  // Ideas and results of the challenge as CSV or PDF (R3-39); also usable for other packages.
  app.get(
    '/api/billing/challenge-export',
    tenantHandler(async (ctx, req, reply) => {
      const { format } = z.object({ format: z.enum(['csv', 'pdf']).default('csv') }).parse(req.query);
      const rows = await challengeExport(ctx);
      await audit(ctx, 'challenge.export', 'tenant', ctx.tenantId, null, { format, rows: rows.length });
      if (format === 'pdf') {
        const name = (await ctx.db.query<{ name: string }>('SELECT name FROM tenants WHERE id = $1', [ctx.tenantId])).rows[0].name;
        reply.header('content-disposition', 'attachment; filename="challenge-ergebnisse.pdf"').type('application/pdf');
        return exportPdf(rows, name, ctx.locale, ctx.settings.minGroupSize);
      }
      reply.header('content-disposition', 'attachment; filename="challenge-ergebnisse.csv"').type('text/csv; charset=utf-8');
      return toCsv([
        exportHeader(ctx.locale),
        ...rows.map((r) => [r.challenge, r.number, r.title, r.status, r.submittedAt ?? '', r.crowdCount, r.crowdMean ?? '', r.juryCount, r.juryMean ?? '']),
      ]);
    }, admin),
  );

  // ------------------------------------------------------------ AI proposal for the process (R3-03)

  app.get(
    '/api/admin/process-templates',
    tenantHandler(async (ctx) =>
      PROCESS_TEMPLATES.map((id) => ({ id, input: TEMPLATE_INPUTS[id], proposal: ruleProposal(TEMPLATE_INPUTS[id], ctx.settings.scorecard.criteria, ctx.locale) })), admin),
  );

  app.post(
    '/api/admin/process-proposal',
    adminAiHandler(async (ctx, req) => {
      const input = processInput.parse(req.body);
      const run = await runAgent(ctx, processProposalCall(input, ctx.settings));
      const fin = finalize(run, [], input.description);
      const { output: _o, ...rest } = fin;
      const saved = await tx(ctx, (c) => saveResult(c, null, 'process_proposal', { ...rest, agent: 'process_proposal' }, run.actionId));
      // The model may only propose: the proposal is checked like any other input before it is shown.
      const proposal = processProposalSchema.parse(fin.output);
      return { resultId: saved.id, proposal, warnings: relocalizeAll(ctx.locale, fin.warnings), model: run.model, builtin: run.provider === 'builtin' };
    }),
  );

  // Takes over a confirmed proposal; every value stays editable under Settings › Process.
  app.post(
    '/api/admin/process-proposal/apply',
    tenantHandler(async (ctx, req) => {
      const body = z.object({ proposal: processProposalSchema, source: z.enum(['ai', 'template']), resultId: z.uuid().nullable().default(null), template: z.enum(PROCESS_TEMPLATES).nullable().default(null) }).parse(req.body);
      const next = applyProposal(ctx.settings, body.proposal);
      const parsed = settingsSchema.safeParse(next);
      if (!parsed.success) throw badRequest(m('admin.settingsInvalid'), localizeIssues(ctx.locale, parsed.error.issues));
      await ctx.db.query('UPDATE tenants SET settings = $1 WHERE id = $2', [JSON.stringify(parsed.data), ctx.tenantId]);
      const pick = (s: typeof ctx.settings) => ({
        thresholds: s.thresholds,
        deadlines: { gate1Workdays: s.deadlines.gate1Workdays, elaborationWorkdays: s.deadlines.elaborationWorkdays },
        weights: Object.fromEntries(s.scorecard.criteria.map((c) => [c.id, c.weight])),
      });
      await audit(ctx, 'settings.process_proposal', 'tenant', ctx.tenantId, pick(ctx.settings), { ...pick(parsed.data), source: body.source, resultId: body.resultId, template: body.template });
      return pick(parsed.data);
    }, admin),
  );

  // ------------------------------------------------------------ operator (AP-17 login)

  app.get('/api/operator/billing/catalogue', operatorHandler(async () => catalogue()));

  app.get(
    '/api/operator/billing/tenants',
    operatorHandler(async () => {
      const rows = await withSystem(async (c) => (await c.query<{ id: string; slug: string; name: string; tz: string | null; plan: (PlanRow & { requested_plan: string | null; requested_employees: number | null; requested_at: Date | null }) | null }>(
        `SELECT t.id, t.slug, t.name, t.settings->>'timezone' AS tz, (SELECT to_jsonb(p) FROM tenant_plans p WHERE p.tenant_id = t.id) AS plan
           FROM tenants t ORDER BY t.name`,
      )).rows);
      const out = [];
      for (const r of rows) {
        const day = todayIn(r.tz || 'Europe/Berlin');
        const state = planState(r.plan, day);
        const usage = await withTenant(r.id, (db) => quotaUsage(db, state, day));
        out.push({
          id: r.id, slug: r.slug, name: r.name, plan: state.plan, status: state.status, readOnly: state.readOnly, employees: state.employees,
          startsOn: state.startsOn, trialEndsOn: state.trialEndsOn, endsOn: state.endsOn, priceEur: planPrice(state.plan, state.employees),
          features: state.features, featureOverrides: r.plan?.feature_overrides ?? {}, quotaOverride: r.plan?.quota_override ?? null,
          request: r.plan?.requested_plan ? { plan: r.plan.requested_plan, employees: r.plan.requested_employees, at: r.plan.requested_at } : null,
          usage,
        });
      }
      return out;
    }),
  );

  app.put(
    '/api/operator/billing/tenants/:id/plan',
    operatorHandler(async (operator, req) => {
      const id = idParam(req);
      const body = planInput.parse(req.body);
      await withSystem(async (c) => {
        if (!(await c.query('SELECT 1 FROM tenants WHERE id = $1', [id])).rowCount) throw notFound(m('billing.tenantNotFound'));
        await setPlan(c, id, body, operator.name, today());
        await operatorLog(c, operator, 'billing.plan', id, { plan: body.plan, employees: body.employees ?? null });
      });
      return { ok: true };
    }),
  );

  app.post(
    '/api/operator/billing/tenants/:id/topups',
    operatorHandler(async (operator, req, reply) => {
      const id = idParam(req);
      const body = z.object({
        analyses: z.number().int().min(1).max(10_000),
        priceEur: z.number().min(0).max(1_000_000),
        note: z.string().max(200).optional(),
        month: z.string().regex(/^\d{4}-\d{2}$/).optional(),
      }).parse(req.body);
      const topupId = await withSystem(async (c) => {
        if (!(await c.query('SELECT 1 FROM tenants WHERE id = $1', [id])).rowCount) throw notFound(m('billing.tenantNotFound'));
        const tid = await bookTopup(c, id, body, operator.name, today());
        await operatorLog(c, operator, 'billing.topup', id, { analyses: body.analyses, priceEur: body.priceEur });
        return tid;
      });
      reply.code(201);
      return { id: topupId };
    }),
  );

  app.get(
    '/api/operator/billing/invoices',
    operatorHandler(async (_op, req) => {
      const { tenant } = z.object({ tenant: z.uuid().optional() }).parse(req.query);
      return withSystem(async (c) => (await c.query<InvoiceRow & { tenant_name: string }>(
        `SELECT i.*, t.name AS tenant_name FROM invoices i JOIN tenants t ON t.id = i.tenant_id
          WHERE $1::uuid IS NULL OR i.tenant_id = $1 ORDER BY i.period_start DESC, i.number DESC LIMIT 500`,
        [tenant ?? null],
      )).rows.map((i) => ({ ...invoiceView(i), tenantId: i.tenant_id, tenantName: i.tenant_name })));
    }),
  );

  // Drafts of a month for one or all workspaces; an existing draft is recalculated.
  app.post(
    '/api/operator/billing/invoices/generate',
    operatorHandler(async (operator, req) => {
      const body = z.object({ month: z.string().regex(/^\d{4}-\d{2}$/), tenantId: z.uuid().optional() }).parse(req.body);
      return withSystem(async (c) => {
        const ids = body.tenantId ? [body.tenantId] : (await c.query<{ tenant_id: string }>('SELECT tenant_id FROM tenant_plans')).rows.map((r) => r.tenant_id);
        const created = [];
        for (const id of ids) {
          const inv = await createInvoice(c, id, 'monthly', `${body.month}-01`);
          if (inv) created.push(invoiceView(inv));
        }
        await operatorLog(c, operator, 'billing.invoices', body.tenantId ?? null, { month: body.month, count: created.length });
        return created;
      });
    }),
  );

  app.get(
    '/api/operator/billing/invoices/:id/pdf',
    operatorHandler(async (_op, req, reply) => {
      const inv = await withSystem(async (c) => (await c.query<InvoiceRow & { tenant_name: string }>(
        'SELECT i.*, t.name AS tenant_name FROM invoices i JOIN tenants t ON t.id = i.tenant_id WHERE i.id = $1', [idParam(req)],
      )).rows[0]);
      if (!inv) throw notFound(m('billing.invoiceNotFound'));
      reply.header('content-disposition', `attachment; filename="${inv.number}.pdf"`).type('application/pdf');
      return invoicePdf(inv, inv.tenant_name, requestLocale(req));
    }),
  );

  // Conversion rates (R3-39): challenge package and trial into an annual licence.
  app.get('/api/operator/billing/kpis', operatorHandler(async () => withSystem((c) => conversionKpis(c))));

}
