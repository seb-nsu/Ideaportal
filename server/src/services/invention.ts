import { z } from 'zod';
import { latestContent } from '../ai/pipeline.js';
import { m, tr } from '../i18n/index.js';
import { isTriage, type Ctx } from '../lib/context.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { audit } from './audit.js';

// Invention disclosure check (R3-25): the triage team answers "possible invention?" at Gate 1,
// supported by the patent search (R2-24), the risk and compliance check (R2-29) and simple
// signals in the text. A possible invention gets no web search (a query could disclose it before
// a filing). Forwarding to a target channel of kind "patent" makes the idea confidential and notes
// the claim period of the German employee inventions act. The portal decides nothing here; the
// hints are no legal advice.

export const inventionInput = z.object({ check: z.enum(['possible', 'no']).nullable() });

interface InventionRow {
  id: string;
  status: string;
  confidential: boolean;
  title: string;
  problem: string;
  solution: string;
  invention_check: 'possible' | 'no' | null;
  invention_checked_at: string | null;
  checked_by_name: string | null;
  invention_forwarded_on: string | null;
  invention_claim_until: string | null;
}

async function loadIdea(ctx: Ctx, ideaId: string): Promise<InventionRow> {
  if (!isTriage(ctx.user)) throw forbidden();
  const r = await ctx.db.query<InventionRow>(
    `SELECT i.id, i.status, i.confidential, i.title, i.problem, i.solution, i.invention_check, i.invention_checked_at,
            u.display_name AS checked_by_name, i.invention_forwarded_on, i.invention_claim_until
       FROM ideas i LEFT JOIN users u ON u.id = i.invention_checked_by WHERE i.id = $1`,
    [ideaId],
  );
  if (!r.rows[0]) throw notFound();
  return r.rows[0];
}

// Words that point to a technical novelty (German and English). Only a hint for the triage team.
const SIGNALS = /\b(erfindung|erfunden|patent\w*|neuartig\w*|verfahren|vorrichtung\w*|sensor\w*|prototyp\w*|mechanismus|algorithmus|schaltung|werkstoff|invention|invented|novel|device|apparatus|method)\b/gi;

export function textSignals(text: string): string[] {
  return [...new Set([...text.matchAll(SIGNALS)].map((x) => x[0].toLowerCase()))].slice(0, 8);
}

type Hint = { source: 'R2-24' | 'R2-29' | 'text'; light: 'green' | 'yellow' | 'red' | null; text: string };

export async function inventionView(ctx: Ctx, ideaId: string) {
  const idea = await loadIdea(ctx, ideaId);
  const l = ctx.locale;
  const hints: Hint[] = [];
  const patents = await latestContent<{ hits?: unknown[] }>(ctx, idea.id, 'patents');
  if (patents) hints.push({ source: 'R2-24', light: patents.hits?.length ? 'yellow' : 'green', text: tr(l, m('compliance.invention.hint.patents', { n: patents.hits?.length ?? 0 })) });
  else hints.push({ source: 'R2-24', light: null, text: tr(l, m('compliance.invention.hint.noPatents')) });
  const risk = await latestContent<{ areas?: { area: string; light: 'green' | 'yellow' | 'red'; finding: string }[] }>(ctx, idea.id, 'risk_check');
  for (const a of (risk?.areas ?? []).filter((x) => x.area === 'patentability' || x.area === 'employee_invention')) {
    hints.push({ source: 'R2-29', light: a.light, text: tr(l, m(`compliance.invention.hint.${a.area as 'patentability' | 'employee_invention'}`, { finding: a.finding })) });
  }
  if (!risk) hints.push({ source: 'R2-29', light: null, text: tr(l, m('compliance.invention.hint.noRisk')) });
  const words = textSignals(`${idea.title} ${idea.problem} ${idea.solution}`);
  hints.push({ source: 'text', light: words.length ? 'yellow' : 'green', text: tr(l, words.length ? m('compliance.invention.hint.words', { words: words.join(', ') }) : m('compliance.invention.hint.noWords')) });
  return {
    enabled: ctx.settings.invention.enabled,
    check: idea.invention_check,
    checkedAt: idea.invention_checked_at,
    checkedBy: idea.checked_by_name,
    confidential: idea.confidential,
    webSearchBlocked: idea.invention_check === 'possible',
    hints,
    patentChannels: ctx.settings.targetChannels.filter((c) => c.kind === 'patent').map((c) => ({ id: c.id, name: c.name })),
    forwardedOn: idea.invention_forwarded_on,
    claimUntil: idea.invention_claim_until,
    claimMonths: ctx.settings.invention.claimMonths,
    notice: tr(l, m('compliance.invention.notice', { months: ctx.settings.invention.claimMonths })),
  };
}

export async function setInventionCheck(ctx: Ctx, ideaId: string, body: unknown) {
  const { check } = inventionInput.parse(body);
  const idea = await loadIdea(ctx, ideaId);
  if (!ctx.settings.invention.enabled) throw badRequest(m('compliance.invention.disabled'));
  if (idea.status === 'draft') throw badRequest(m('compliance.invention.draft'));
  await ctx.db.query(
    'UPDATE ideas SET invention_check = $2, invention_checked_at = CASE WHEN $2::text IS NULL THEN NULL ELSE now() END, invention_checked_by = CASE WHEN $2::text IS NULL THEN NULL ELSE $3::uuid END WHERE id = $1',
    [idea.id, check, ctx.user!.id],
  );
  await audit(ctx, 'idea.invention_check', 'idea', idea.id, { invention_check: idea.invention_check }, { invention_check: check });
  return inventionView(ctx, ideaId);
}

/** Same day n months later; a missing day becomes the last day of the month (§ 188 (3) BGB). */
export function addMonths(isoDate: string, months: number): string {
  const [y, mo, d] = isoDate.split('-').map(Number);
  const target = new Date(Date.UTC(y, mo - 1 + months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, last));
  return target.toISOString().slice(0, 10);
}

/**
 * Forwarding to a patent channel at Gate 1: the idea becomes confidential, counts as a possible
 * invention (no web search) and gets the date until which the claim period runs at the latest.
 * Called inside the triage transaction before the status changes.
 */
export async function markPatentForward(ctx: Ctx, ideaId: string): Promise<{ claimUntil: string; months: number }> {
  const months = ctx.settings.invention.claimMonths;
  const claimUntil = addMonths(ctx.today, months);
  await ctx.db.query(
    `UPDATE ideas SET confidential = true, invention_check = 'possible',
            invention_checked_at = COALESCE(invention_checked_at, now()), invention_checked_by = COALESCE(invention_checked_by, $2),
            invention_forwarded_on = $3, invention_claim_until = $4
      WHERE id = $1`,
    [ideaId, ctx.user!.id, ctx.today, claimUntil],
  );
  await audit(ctx, 'idea.invention_forward', 'idea', ideaId, null, { confidential: true, invention_forwarded_on: ctx.today, invention_claim_until: claimUntil });
  return { claimUntil, months };
}
