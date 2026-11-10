import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { isTriage, type Ctx } from '../lib/context.js';
import { DASHBOARD_ROLES, areaFilter, areaScope, selectableAreas } from '../services/areas.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { m, tr, type Locale, type MessageKey } from '../i18n/index.js';
import { tenantHandler } from '../http.js';
import { audit } from '../services/audit.js';
import {
  canManageChallenge,
  canSeeRanking,
  challengeEnded,
  challengeExtrasInput,
  isJury,
  juryCriteria,
  loadChallenge,
  myJuryScores,
  publishRanking,
  ranking,
  rateAsJury,
  setJury,
  updateChallengeExtras,
} from '../services/recognition.js';
import { scoresInput } from '../services/elaboration.js';
import { loadIdea } from '../services/workflow.js';
import { listIdeas } from './ideas.js';
import { challengeReport, throughput as throughputTimes } from '../services/metrics.js';
import {
  acceptsIdeas,
  challengePhaseInput,
  challengeTemplates,
  checkPlan,
  crowdRatingEnabled,
  crowdRatingView,
  phaseOn,
  rateIdea,
  ratingInput,
  updateChallengePhases,
  type ChallengePhaseRow,
} from '../services/challenges.js';
import { updateUseCases, useCaseInput } from '../services/usecases.js';
import { externalOn } from '../services/external.js';
import { featureRequestsOn } from '../services/featureRequests.js';

export const challengeInput = z.object({
  title: z.string().trim().min(3).max(140),
  question: z.string().trim().min(10).max(3000),
  topic: z.string().trim().max(80).nullable().default(null),
  contact: z.string().trim().min(2).max(200),
  startsOn: z.iso.date(),
  endsOn: z.iso.date(),
}).extend(challengeExtrasInput.shape).extend(challengePhaseInput.shape).extend(useCaseInput.shape);

const STATUS_KEYS = ['submitted', 'in_question', 'fast_lane', 'elaboration', 'forwarded', 'rejected', 'implementing', 'piloting',
  'integrated', 'parked', 'completed', 'closed_no_answer'];
/** Status in the given language; unknown statuses stay as they are. */
const statusLabel = (locale: Locale, status: string) =>
  STATUS_KEYS.includes(status) ? tr(locale, m(`misc.status.${status}` as MessageKey)) : status;

export async function dashboard(ctx: Ctx, from: string, to: string, areaId: string | null = null) {
  const min = ctx.settings.minGroupSize;
  const range = [from, to];
  const inRange = `coalesce(i.submitted_at, i.created_at)::date BETWEEN $1 AND $2`;
  // Each query gets the area filter as its last parameter (none for tenant-wide roles without a chosen area).
  const scoped = (col: string, base: unknown[] = range) => {
    const params = [...base];
    return { sql: areaFilter(ctx, DASHBOARD_ROLES, col, params, areaId), params };
  };
  const f = scoped('i.id');
  const funnel = await ctx.db.query<{ status: string; count: number }>(
    `SELECT i.status, count(*)::int AS count FROM ideas i WHERE i.status <> 'draft' AND ${inRange} ${f.sql} GROUP BY i.status ORDER BY count DESC`,
    f.params,
  );
  const dl = scoped('d.idea_id');
  const deadlines = await ctx.db.query<{ total: number; on_time: number }>(
    `SELECT count(*)::int AS total, count(*) FILTER (WHERE d.completed_at::date <= d.due_on)::int AS on_time
       FROM deadlines d WHERE d.phase = 'gate1' AND d.completed_at IS NOT NULL AND d.completed_at::date BETWEEN $1 AND $2 ${dl.sql}`,
    dl.params,
  );
  const tp = scoped('i.id');
  const throughput = await ctx.db.query<{ avg_days: number | null }>(
    `SELECT round(avg(extract(epoch FROM d.decided_at - i.submitted_at) / 86400)::numeric, 1)::float AS avg_days
       FROM decisions d JOIN ideas i ON i.id = d.idea_id WHERE d.gate = 1 AND d.decided_at::date BETWEEN $1 AND $2 ${tp.sql}`,
    tp.params,
  );
  const re = scoped('im.idea_id');
  const realization = await ctx.db.query<{ approved: number; completed: number }>(
    `SELECT count(DISTINCT im.idea_id)::int AS approved, count(DISTINCT im.idea_id) FILTER (WHERE im.status = 'done')::int AS completed
       FROM implementations im WHERE im.created_at::date BETWEEN $1 AND $2 ${re.sql}`,
    re.params,
  );
  const be = scoped('idea_id');
  const benefit = await ctx.db.query<{ kind: string; total: number; count: number }>(
    `SELECT benefit_kind AS kind, coalesce(sum(benefit_value), 0)::float AS total, count(*)::int AS count
       FROM implementations WHERE status = 'done' AND closed_at::date BETWEEN $1 AND $2 ${be.sql} GROUP BY benefit_kind ORDER BY benefit_kind`,
    be.params,
  );
  const sa = scoped('idea_id');
  const satisfaction = await ctx.db.query<{ avg: number | null; count: number; people: number }>(
    `SELECT round(avg(score)::numeric, 2)::float AS avg, count(*)::int AS count, count(DISTINCT user_id)::int AS people
       FROM feedback WHERE created_at::date BETWEEN $1 AND $2 ${sa.sql}`,
    sa.params,
  );
  // Gate 2 decisions by the committee and delegated to heads of department (R2-05).
  const g2 = scoped('d.idea_id');
  const gate2 = await ctx.db.query<{ committee: number; delegated: number }>(
    `SELECT count(*) FILTER (WHERE NOT d.delegated)::int AS committee, count(*) FILTER (WHERE d.delegated)::int AS delegated
       FROM decisions d WHERE d.gate = 2 AND d.decided_at::date BETWEEN $1 AND $2 ${g2.sql}`,
    g2.params,
  );
  const un = scoped('i.id', [...range, tr(ctx.locale, m('misc.unitUnknown'))]);
  const units = await ctx.db.query<{ unit: string; ideas: number; people: number }>(
    `SELECT coalesce(u.org_unit, $3) AS unit, count(*)::int AS ideas, count(DISTINCT i.author_id)::int AS people
       FROM ideas i JOIN users u ON u.id = i.author_id
      WHERE i.status <> 'draft' AND ${inRange} ${un.sql} GROUP BY 1 ORDER BY 1`,
    un.params,
  );
  // Privacy (R1-37, R1-41): groups with fewer than minGroupSize people are merged.
  const byUnit: { unit: string; ideas: number | null; merged: boolean }[] = [];
  const small = { ideas: 0, people: 0, groups: 0 };
  for (const u of units.rows) {
    if (u.people >= min) byUnit.push({ unit: u.unit, ideas: u.ideas, merged: false });
    else Object.assign(small, { ideas: small.ideas + u.ideas, people: small.people + u.people, groups: small.groups + 1 });
  }
  if (small.groups) {
    byUnit.push({ unit: tr(ctx.locale, m('misc.unitsMerged')), ideas: small.people >= min ? small.ideas : null, merged: true });
  }
  const d = deadlines.rows[0];
  const r = realization.rows[0];
  const s = satisfaction.rows[0];
  return {
    from,
    to,
    submitted: funnel.rows.reduce((n, x) => n + x.count, 0),
    funnel: funnel.rows.map((x) => ({ ...x, label: statusLabel(ctx.locale, x.status) })),
    deadlineAdherence: d.total ? { total: d.total, onTime: d.on_time, rate: Math.round((d.on_time / d.total) * 100) } : null,
    avgDaysToGate1: throughput.rows[0].avg_days,
    realization: r.approved ? { approved: r.approved, completed: r.completed, rate: Math.round((r.completed / r.approved) * 100) } : null,
    benefit: benefit.rows,
    gate2Decisions: gate2.rows[0],
    satisfaction: s.people >= min ? { avg: s.avg, count: s.count } : { avg: null, count: s.count, hiddenBelow: min },
    byUnit,
    minGroupSize: min,
    // Median and 90th percentile per section with time series and baseline (R2-41).
    throughput: await throughputTimes(ctx, from, to, null, areaScope(ctx, DASHBOARD_ROLES, areaId)),
    baselineNote: ctx.settings.baselines.note,
    areaId,
  };
}

function csvCell(v: unknown): string {
  const s = v == null ? '' : String(v);
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s; // no formula injection in spreadsheets
  return /[";\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function toCsv(rows: unknown[][]): string {
  return rows.map((r) => r.map(csvCell).join(';')).join('\n') + '\n';
}

export async function miscRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/settings',
    tenantHandler(async (ctx) => {
      const s = ctx.settings;
      return {
        topics: s.topics,
        targetChannels: s.targetChannels,
        deadlines: s.deadlines,
        thresholds: s.thresholds,
        elaboration: s.elaboration,
        texts: { privacyNotice: s.texts.privacyNotice, faq: s.texts.faq },
        lanes: { fast_lane: s.texts.fast_lane, elaborate: s.texts.elaborate, forward: s.texts.forward, reject: s.texts.reject },
        minGroupSize: s.minGroupSize,
        guarantee: s.guarantee,
        // External participation and feature requests switched on (R3-19, R3-20).
        external: externalOn(ctx),
        featureRequests: featureRequestsOn(ctx),
        today: ctx.today,
      };
    }),
  );

  app.get(
    '/api/users',
    tenantHandler(async (ctx, req) => {
      const { q, role } = z.object({ q: z.string().max(100).default(''), role: z.string().optional() }).parse(req.query);
      const r = await ctx.db.query(
        `SELECT id, display_name AS "displayName", org_unit AS "orgUnit"${isTriage(ctx.user) ? ', email' : ''}
           FROM users WHERE active AND (display_name ILIKE $1 OR email ILIKE $1) AND ($2::text IS NULL OR $2 = ANY(roles))
          ORDER BY display_name LIMIT 20`,
        [`%${q.replace(/[\\%_]/g, (m) => '\\' + m)}%`, role ?? null],
      );
      return r.rows;
    }),
  );

  app.get(
    '/api/notifications',
    tenantHandler(async (ctx) => {
      const r = await ctx.db.query(
        `SELECT id, subject, body, idea_id AS "ideaId", read_at AS "readAt", created_at AS "createdAt"
           FROM outbox WHERE user_id = $1 ORDER BY id DESC LIMIT 50`,
        [ctx.user!.id],
      );
      const unread = await ctx.db.query<{ n: number }>('SELECT count(*)::int AS n FROM outbox WHERE user_id = $1 AND read_at IS NULL', [ctx.user!.id]);
      return { items: r.rows, unread: unread.rows[0].n };
    }, { external: true }),
  );

  app.post(
    '/api/notifications/read',
    tenantHandler(async (ctx) => {
      await ctx.db.query('UPDATE outbox SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [ctx.user!.id]);
      return { ok: true };
    }, { external: true }),
  );

  // Challenges (R1-34)
  app.get(
    '/api/challenges',
    tenantHandler(async (ctx) => {
      const r = await ctx.db.query(
        `SELECT c.id, c.title, c.question, c.topic, c.contact, c.starts_on AS "startsOn", c.ends_on AS "endsOn", c.summary,
                (c.starts_on <= $1 AND c.ends_on >= $1) AS active,
                (SELECT count(*) FROM ideas i WHERE i.challenge_id = c.id AND i.status <> 'draft')::int AS ideas,
                c.phase, c.phase_plan AS "phasePlan"
           FROM challenges c ORDER BY active DESC, c.ends_on DESC`,
        [ctx.today],
      );
      // Phases (R2-52): with a phase plan, ideas are taken only in the collect phase.
      return r.rows.map((c) => ({ ...c, acceptsIdeas: acceptsIdeas({ phase_plan: c.phasePlan, phase: c.phase }) }));
    }),
  );

  // Templates that prefill a new challenge (R2-52).
  app.get(
    '/api/challenges/templates',
    tenantHandler(async (ctx) => challengeTemplates(ctx), { roles: ['admin', 'triage', 'committee'] }),
  );

  app.post(
    '/api/challenges',
    tenantHandler(
      async (ctx, req, reply) => {
        const body = challengeInput.parse(req.body);
        if (body.endsOn < body.startsOn) throw badRequest(m('misc.endBeforeStart'));
        if (body.topic && !ctx.settings.topics.includes(body.topic)) throw badRequest(m('misc.unknownTopic'));
        // Phase plan (R2-52): the collect phase starts the challenge; the phase follows the plan from the start.
        const plan = body.phasePlan ?? null;
        if (plan) checkPlan(plan, body.endsOn);
        const r = await ctx.db.query<{ id: string }>(
          `INSERT INTO challenges (tenant_id, title, question, topic, contact, sponsor_id, starts_on, ends_on, custom_fields, teams_allowed, jury_criteria,
                                   phase_plan, phase, phase_changed_at, rating_criteria, template)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, CASE WHEN $13::text IS NULL THEN NULL ELSE now() END, $14, $15) RETURNING id`,
          [ctx.tenantId, body.title, body.question, body.topic, body.contact, ctx.user!.id, plan?.collect ?? body.startsOn, body.endsOn,
           JSON.stringify(body.customFields ?? []), body.teamsAllowed ?? false, JSON.stringify(body.juryCriteria ?? []),
           plan ? JSON.stringify(plan) : null, phaseOn(plan, ctx.today), JSON.stringify(body.ratingCriteria ?? []), body.template ?? null],
        );
        await audit(ctx, 'challenge.create', 'challenge', r.rows[0].id, null, body);
        // Target value, confirmer and hackathon settings (R3-32 … R3-34).
        await updateUseCases(ctx, r.rows[0].id, useCaseInput.parse(body));
        reply.code(201);
        return { id: r.rows[0].id };
      },
      { roles: ['admin', 'triage', 'committee'] },
    ),
  );

  app.get(
    '/api/challenges/:id',
    tenantHandler(async (ctx, req) => {
      const { id } = z.object({ id: z.uuid() }).parse(req.params);
      const c = await ctx.db.query(
        `SELECT c.id, c.title, c.question, c.topic, c.contact, c.starts_on AS "startsOn", c.ends_on AS "endsOn", c.summary,
                (c.starts_on <= $2 AND c.ends_on >= $2) AS active, c.custom_fields AS "customFields", c.teams_allowed AS "teamsAllowed",
                c.jury_criteria AS "ownJuryCriteria", c.ranking_published_at AS "rankingPublishedAt", c.sponsor_id AS "sponsorId",
                c.phase, c.phase_plan AS "phasePlan", c.phase_changed_at AS "phaseChangedAt", c.template, c.rating_criteria AS "ownRatingCriteria",
                coalesce((SELECT json_agg(json_build_object('id', u.id, 'displayName', u.display_name, 'orgUnit', u.org_unit) ORDER BY u.display_name)
                   FROM challenge_jury j JOIN users u ON u.id = j.user_id WHERE j.challenge_id = c.id), '[]') AS jury
           FROM challenges c WHERE c.id = $1`,
        [id, ctx.today],
      );
      if (!c.rows[0]) throw notFound(m('recognition.challengeNotFound'));
      // Jury, ranking and custom fields (R2-35).
      const row = await loadChallenge(ctx, id);
      const jury = await isJury(ctx, id);
      const showRanking = await canSeeRanking(ctx, row);
      const ideas = await listIdeas(ctx, { scope: 'all', challengeId: id, sort: 'supporters' });
      return {
        ...c.rows[0],
        ended: challengeEnded(ctx, row),
        juryCriteria: juryCriteria(ctx, row),
        isJury: jury,
        ranking: showRanking ? await ranking(ctx, row) : null,
        myJuryScores: jury ? await myJuryScores(ctx, row) : {},
        can: {
          manage: canManageChallenge(ctx, row),
          publishRanking: !row.ranking_published_at && challengeEnded(ctx, row) && (row.sponsor_id === ctx.user!.id || ctx.user!.roles.includes('admin')),
        },
        ideas,
        // Phases (R2-52) and crowd rating (R2-51; null when switched off for the workspace).
        acceptsIdeas: acceptsIdeas(row as ChallengePhaseRow),
        crowdRating: await crowdRatingView(ctx, row as ChallengePhaseRow, ideas.map((i: { id: string }) => i.id)),
      };
    }),
  );

  app.post(
    '/api/challenges/:id/close',
    tenantHandler(
      async (ctx, req) => {
        const { id } = z.object({ id: z.uuid() }).parse(req.params);
        const { summary } = z.object({ summary: z.string().trim().max(5000).optional() }).parse(req.body ?? {});
        const counts = await ctx.db.query<{ status: string; n: number }>(
          `SELECT status, count(*)::int AS n FROM ideas WHERE challenge_id = $1 AND status <> 'draft' GROUP BY status`,
          [id],
        );
        const total = counts.rows.reduce((n, r) => n + r.n, 0);
        // Stored with the challenge, so it is written in the workspace language (German).
        const auto = total
          ? tr('de', m('misc.challengeSummaryList', { count: total, list: counts.rows.map((r) => `${r.n} ${statusLabel('de', r.status)}`).join(', ') }))
          : tr('de', m('misc.challengeSummary', { count: total }));
        const r = await ctx.db.query(
          `UPDATE challenges SET summary = $2, ends_on = LEAST(ends_on, $3::date), starts_on = LEAST(starts_on, $3::date),
                  phase = CASE WHEN phase_plan IS NULL THEN phase ELSE 'result' END,
                  phase_changed_at = CASE WHEN phase_plan IS NULL OR phase = 'result' THEN phase_changed_at ELSE now() END
            WHERE id = $1`,
          [id, summary || auto, ctx.today],
        );
        if (!r.rowCount) throw notFound(m('recognition.challengeNotFound'));
        await audit(ctx, 'challenge.close', 'challenge', id, null, { summary: summary || auto });
        return { ok: true, summary: summary || auto };
      },
      { roles: ['admin', 'triage', 'committee'] },
    ),
  );

  app.patch(
    '/api/challenges/:id',
    tenantHandler(async (ctx, req) => {
      const { id } = z.object({ id: z.uuid() }).parse(req.params);
      const extras = challengeExtrasInput.parse(req.body);
      const phases = challengePhaseInput.parse(req.body);
      const row = await loadChallenge(ctx, id, true);
      await updateChallengeExtras(ctx, row, extras);
      await updateChallengePhases(ctx, row as ChallengePhaseRow, phases);
      return { ok: true };
    }),
  );

  app.put(
    '/api/challenges/:id/jury',
    tenantHandler(async (ctx, req) => {
      const { id } = z.object({ id: z.uuid() }).parse(req.params);
      const { userIds } = z.object({ userIds: z.array(z.uuid()).max(30) }).parse(req.body);
      await setJury(ctx, await loadChallenge(ctx, id, true), userIds);
      return { ok: true };
    }),
  );

  app.put(
    '/api/challenges/:id/ideas/:ideaId/jury-score',
    tenantHandler(async (ctx, req) => {
      const p = z.object({ id: z.uuid(), ideaId: z.uuid() }).parse(req.params);
      const body = scoresInput.parse(req.body);
      return rateAsJury(ctx, await loadChallenge(ctx, p.id), await loadIdea(ctx, p.ideaId), body.scores, body.comment ?? null);
    }),
  );

  // Crowd rating (R2-51): one rating per person and idea, changeable; answers only with aggregates.
  app.put(
    '/api/challenges/:id/ideas/:ideaId/rating',
    tenantHandler(async (ctx, req) => {
      const p = z.object({ id: z.uuid(), ideaId: z.uuid() }).parse(req.params);
      if (!crowdRatingEnabled(ctx)) throw forbidden(m('challenges.crowdRatingOff'));
      const body = ratingInput.parse(req.body);
      const row = (await loadChallenge(ctx, p.id)) as ChallengePhaseRow;
      return rateIdea(ctx, row, await loadIdea(ctx, p.ideaId), body.scores);
    }),
  );

  app.post(
    '/api/challenges/:id/ranking/publish',
    tenantHandler(async (ctx, req) => {
      const { id } = z.object({ id: z.uuid() }).parse(req.params);
      await publishRanking(ctx, await loadChallenge(ctx, id, true));
      return { ok: true };
    }),
  );

  // Dashboard (R1-37)
  const range = z.object({ from: z.iso.date().optional(), to: z.iso.date().optional(), areaId: z.uuid().optional() });
  const resolveRange = (ctx: Ctx, q: z.infer<typeof range>) => {
    const to = q.to ?? ctx.today;
    const from = q.from ?? `${Number(to.slice(0, 4)) - 1}${to.slice(4)}`;
    return { from, to };
  };

  app.get(
    '/api/dashboard',
    tenantHandler(async (ctx, req) => {
      const q = range.parse(req.query);
      const { from, to } = resolveRange(ctx, q);
      return dashboard(ctx, from, to, q.areaId ?? null);
    }, { roles: DASHBOARD_ROLES }),
  );

  // Areas for the dashboard filter (R3-29): all for tenant-wide roles, else the person's own.
  app.get(
    '/api/dashboard/areas',
    tenantHandler(async (ctx) => selectableAreas(ctx, DASHBOARD_ROLES), { roles: DASHBOARD_ROLES }),
  );

  app.get(
    '/api/dashboard.csv',
    tenantHandler(async (ctx, req, reply) => {
      const q = range.parse(req.query);
      const { from, to } = resolveRange(ctx, q);
      const d = await dashboard(ctx, from, to, q.areaId ?? null);
      const t = (key: MessageKey, vars?: Record<string, string | number>) => tr(ctx.locale, m(key, vars));
      const below = t('misc.csv.belowGroup', { n: d.minGroupSize });
      const rows: unknown[][] = [[t('misc.csv.metric'), t('misc.csv.value')], [t('misc.csv.period'), t('misc.csv.range', { from, to })], [t('misc.csv.submitted'), d.submitted]];
      for (const f of d.funnel) rows.push([t('misc.csv.status', { label: f.label }), f.count]);
      rows.push([t('misc.csv.adherence'), d.deadlineAdherence?.rate ?? '']);
      rows.push([t('misc.csv.avgDays'), d.avgDaysToGate1 ?? '']);
      rows.push([t('misc.csv.realization'), d.realization?.rate ?? '']);
      for (const b of d.benefit) rows.push([t('misc.csv.benefit', { kind: b.kind }), b.total]);
      rows.push([t('misc.csv.gate2Committee'), d.gate2Decisions.committee]);
      rows.push([t('misc.csv.gate2Delegated'), d.gate2Decisions.delegated]);
      rows.push([t('misc.csv.satisfaction'), d.satisfaction.avg ?? below]);
      for (const u of d.byUnit) rows.push([t('misc.csv.unit', { unit: u.unit }), u.ideas ?? below]);
      rows.push([], [t('misc.csv.throughput'), t('misc.csv.count'), t('misc.csv.median'), t('misc.csv.p90'), t('misc.csv.baseline')]);
      for (const s of d.throughput) rows.push([s.label, s.count, s.medianDays ?? '', s.p90Days ?? '', s.baselineDays ?? '']);
      rows.push([], [t('misc.csv.seriesSection'), t('misc.csv.month'), t('misc.csv.count'), t('misc.csv.median')]);
      for (const t of d.throughput) for (const p of t.series) rows.push([t.label, p.month, p.count, p.medianDays]);
      reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="dashboard-${to}.csv"`);
      return '﻿' + toCsv(rows);
    }, { roles: ['admin', 'triage', 'committee'] }),
  );

  // Challenge report (R2-41): submissions, decisions, implementations and benefit per challenge.
  app.get(
    '/api/dashboard/challenges',
    tenantHandler(async (ctx, req) => {
      const q = range.parse(req.query);
      const { from, to } = resolveRange(ctx, q);
      return { from, to, minGroupSize: ctx.settings.minGroupSize, items: await challengeReport(ctx, from, to, areaScope(ctx, DASHBOARD_ROLES, q.areaId ?? null)) };
    }, { roles: ['admin', 'triage', 'committee', 'lead'] }),
  );

  app.get(
    '/api/dashboard/challenges.csv',
    tenantHandler(async (ctx, req, reply) => {
      const q = range.parse(req.query);
      const { from, to } = resolveRange(ctx, q);
      const items = await challengeReport(ctx, from, to, areaScope(ctx, DASHBOARD_ROLES, q.areaId ?? null));
      const t = (key: MessageKey) => tr(ctx.locale, m(key));
      const below = tr(ctx.locale, m('misc.csv.belowGroup', { n: ctx.settings.minGroupSize }));
      const rows: unknown[][] = [['misc.csv.challenge', 'misc.csv.from', 'misc.csv.to', 'misc.csv.ideas', 'misc.csv.participants', 'misc.csv.decided',
        'misc.csv.implemented', 'misc.csv.medianDays', 'misc.csv.actualBenefit', 'misc.csv.confirmedBenefit', 'misc.csv.targetValue'].map((k) => t(k as MessageKey))];
      for (const c of items) {
        rows.push([c.title, c.startsOn, c.endsOn, c.ideas, c.participants ?? below, c.decided, c.implemented, c.medianDaysToGate1 ?? '',
          c.benefit.map((b) => `${b.kind}: ${b.total}`).join(', '),
          // Confirmed by controlling and target value (R3-33).
          c.benefit.map((b) => `${b.kind}: ${b.confirmed}`).join(', '),
          c.target ? `${c.target.kind}: ${c.target.value}` : '']);
      }
      reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="challenges-${to}.csv"`);
      return '﻿' + toCsv(rows);
    }, { roles: ['admin', 'triage', 'committee'] }),
  );
}
