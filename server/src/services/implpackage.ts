import { z } from 'zod';
import { runAgent } from '../ai/gateway.js';
import { BRIEF_FIELDS, briefSchema, packageCall, storySchema, type ImplementationPackage } from '../ai/package.js';
import type { Ctx } from '../lib/context.js';
import { conflict, notFound } from '../lib/errors.js';
import { m, tr, type Locale, type MessageKey } from '../i18n/index.js';
import { audit } from './audit.js';
import { HANDOVER_STATUSES, ideaUrl, requireManager } from './connectors.js';
import { addEvent, requireStatus, type IdeaRow } from './workflow.js';

// Implementation package (R3-18): the AI gateway drafts project brief and user stories from an
// approved idea; owner and triage edit the draft, export it (Markdown, PDF) and hand it over
// through the connectors (stories become child items).

export const packageUpdate = z.object({
  brief: briefSchema,
  stories: z.array(storySchema).min(1).max(15),
  /** Version the edit is based on (optimistic locking). */
  version: z.number().int().min(1),
});
export const generateInput = z.object({ replaceEdited: z.boolean().default(false) });

interface PackageRow {
  brief: ImplementationPackage['brief'];
  stories: ImplementationPackage['stories'];
  source: 'ai' | 'human';
  ai_action_id: string | null;
  version: number;
  updated_at: Date;
  updated_name: string | null;
}

export async function getPackage(ctx: Ctx, idea: IdeaRow) {
  await requireManager(ctx, idea);
  const r = await ctx.db.query<PackageRow>(
    `SELECT p.brief, p.stories, p.source, p.ai_action_id, p.version, p.updated_at, u.display_name AS updated_name
       FROM implementation_packages p LEFT JOIN users u ON u.id = p.updated_by WHERE p.idea_id = $1`,
    [idea.id],
  );
  const p = r.rows[0];
  if (!p) return null;
  return { brief: p.brief, stories: p.stories, source: p.source, aiActionId: p.ai_action_id, version: p.version, updatedAt: p.updated_at, updatedBy: p.updated_name };
}

export async function generatePackage(ctx: Ctx, idea: IdeaRow, input: z.infer<typeof generateInput>) {
  await requireManager(ctx, idea);
  requireStatus(idea, ...HANDOVER_STATUSES);
  const existing = (await ctx.db.query<{ source: string; version: number }>('SELECT source, version FROM implementation_packages WHERE idea_id = $1 FOR UPDATE', [idea.id])).rows[0];
  if (existing?.source === 'human' && !input.replaceEdited) throw conflict(m('conn.pkg.edited'), 'PACKAGE_EDITED');
  const dossier = Object.fromEntries(
    (await ctx.db.query<{ section: string; content: string }>('SELECT section, content FROM dossier_sections WHERE idea_id = $1', [idea.id])).rows
      .filter((s) => s.content.trim())
      .map((s) => [s.section, s.content]),
  );
  const impl = (await ctx.db.query<{ target_date: string; channel: string }>('SELECT target_date, channel FROM implementations WHERE idea_id = $1', [idea.id])).rows[0];
  // Confidential ideas: sensitive call, the gateway only allows a model with own hosting.
  const run = await runAgent(ctx, packageCall(
    { id: idea.id, title: idea.title, problem: idea.problem, solution: idea.solution, benefit: idea.benefit, topic: idea.topic, ideaType: idea.idea_type, confidential: idea.confidential },
    { dossier, targetDate: impl ? String(impl.target_date) : null, channel: impl?.channel ?? null },
  ));
  const version = (existing?.version ?? 0) + 1;
  await ctx.db.query(
    `INSERT INTO implementation_packages (tenant_id, idea_id, brief, stories, source, ai_action_id, version, created_by, updated_by)
     VALUES ($1, $2, $3, $4, 'ai', $5, $6, $7, $7)
     ON CONFLICT (idea_id) DO UPDATE SET brief = EXCLUDED.brief, stories = EXCLUDED.stories, source = 'ai',
       ai_action_id = EXCLUDED.ai_action_id, version = EXCLUDED.version, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [ctx.tenantId, idea.id, JSON.stringify(run.output.brief), JSON.stringify(run.output.stories), run.actionId, version, ctx.user?.id ?? null],
  );
  await addEvent(ctx, idea, 'implementation_package', m('conn.event.package'));
  await audit(ctx, 'package.generate', 'idea', idea.id, null, { aiActionId: run.actionId, model: run.model, provider: run.provider, stories: run.output.stories.length, version });
  return getPackage(ctx, idea);
}

export async function updatePackage(ctx: Ctx, idea: IdeaRow, input: z.infer<typeof packageUpdate>) {
  await requireManager(ctx, idea);
  requireStatus(idea, ...HANDOVER_STATUSES);
  const before = (await ctx.db.query<{ version: number }>('SELECT version FROM implementation_packages WHERE idea_id = $1 FOR UPDATE', [idea.id])).rows[0];
  if (!before) throw notFound(m('conn.noPackage'));
  if (before.version !== input.version) throw conflict(m('conn.pkg.versionConflict'), 'VERSION_CONFLICT');
  await ctx.db.query(
    `UPDATE implementation_packages SET brief = $2, stories = $3, source = 'human', version = version + 1, updated_by = $4, updated_at = now() WHERE idea_id = $1`,
    [idea.id, JSON.stringify(input.brief), JSON.stringify(input.stories), ctx.user?.id ?? null],
  );
  await audit(ctx, 'package.update', 'idea', idea.id, { version: before.version }, { version: before.version + 1, stories: input.stories.length });
  return getPackage(ctx, idea);
}

const L = (l: Locale, key: MessageKey, vars?: Record<string, string | number>) => tr(l, m(key, vars));

/** Markdown of the package; headings in the language of the reader. */
export function packageMarkdown(l: Locale, idea: IdeaRow, pkg: ImplementationPackage & { source?: string }): string {
  const out: string[] = [`# ${L(l, 'conn.pkg.title', { number: idea.number, title: idea.title })}`, ''];
  if (pkg.source === 'ai') out.push(`> ${L(l, 'conn.pkg.aiNotice')}`, '');
  out.push(`## ${L(l, 'conn.pkg.briefHeading')}`, '');
  for (const f of BRIEF_FIELDS) {
    out.push(`### ${L(l, `conn.pkg.h.${f}` as MessageKey)}`, '', pkg.brief[f].trim() || '–', '');
  }
  out.push(`## ${L(l, 'conn.pkg.storiesHeading')}`, '');
  pkg.stories.forEach((s, i) => {
    out.push(`### ${i + 1}. ${s.title}`, '', s.description.trim(), '');
    if (s.acceptance.length) out.push(`${L(l, 'conn.pkg.acceptance')}`, '', ...s.acceptance.map((a) => `- ${a}`), '');
  });
  out.push(L(l, 'conn.ext.link', { number: idea.number, url: ideaUrl(idea.id) }), '');
  return out.join('\n');
}
