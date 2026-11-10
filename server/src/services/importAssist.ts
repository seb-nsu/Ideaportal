import { z } from 'zod';
import type { Ctx } from '../lib/context.js';
import { badRequest, errorText } from '../lib/errors.js';
import { guessMapping, IMPORT_FIELDS, parseTable, type Mapping } from '../lib/importer.js';
import { cat, m, tr, type MessageKey } from '../i18n/index.js';
import { AiError, runAgent } from '../ai/gateway.js';
import { CLEAN_FIELDS, cleanedRowSchema, importCleanupCall, TITLE_MAX, type CleanField, type CleanedRow, type RawRow } from '../ai/importCleanup.js';
import { findSimilar, type SimilarIdea } from '../search/similar.js';
import { audit } from './audit.js';
import { createIdea, ideaInput, loadIdea, startDeadline } from './workflow.js';

// Import of old ideas with AI support (R4-12), built on the import of R1-39 (lib/importer.ts):
// 1. preview: the file is read with the same column mapping; the AI agent "import_cleanup"
//    cleans the texts and proposes topic fields (batches of ten rows; rows marked confidential
//    only go to a local model or the builtin rules); every row gets the duplicate check against
//    the portal (same title, similar ideas from the duplicate search) and within the file.
// 2. commit: a person confirms the rows, chooses per field between original and AI suggestion,
//    and only then the ideas are created. AI suggestions taken over are marked in the history.

export const AI_IMPORT_FIELDS = [...IMPORT_FIELDS, 'confidential'] as const;
export type AiImportField = (typeof AI_IMPORT_FIELDS)[number];
export type AiMapping = Mapping & { confidential?: number };

export const AI_IMPORT_MAX_ROWS = 500;
const BATCH = 10;
/** From this similarity on a row is proposed to be skipped; below it is only a hint. */
export const SKIP_SIMILARITY = 0.8;

const CONFIDENTIAL_HEADERS = ['vertraulich', 'vertraulichkeit', 'confidential', 'geheim', 'intern vertraulich'];
const YES = new Set(['ja', 'j', 'yes', 'y', 'x', 'true', 'wahr', '1', 'vertraulich', 'confidential']);

export interface PreviewRow {
  row: number;
  original: { title: string; problem: string; solution: string; benefit: string; topic: string };
  /** AI suggestion, marked as such in the interface; null without AI (switched off, budget, no local model). */
  suggestion: (Omit<CleanedRow, 'row'> & { fields: CleanField[] }) | null;
  confidential: boolean;
  email: string;
  authorKnown: boolean;
  duplicate: { kind: 'portal' } | { kind: 'file'; row: number } | null;
  similar: SimilarIdea[];
  include: boolean;
  skipReason: 'title' | 'duplicate' | 'similar' | null;
}

export interface PreviewResult {
  filename: string;
  headers: string[];
  mapping: AiMapping;
  rows: PreviewRow[];
  ai: { used: boolean; batches: number; errors: string[]; actionIds: string[] };
  report: { total: number; included: number; duplicates: number; similar: number; confidential: number; suggestions: number; unknownAuthors: number };
}

const lc = (s: string) => s.trim().toLowerCase();

export async function readRows(filename: string, data: Buffer, given?: AiMapping): Promise<{ headers: string[]; mapping: AiMapping; data: string[][] }> {
  const rows = await parseTable(filename, data);
  if (rows.length < 2) throw badRequest(m('pilot.importRows'));
  const [headers, ...rest] = rows;
  if (rest.length > AI_IMPORT_MAX_ROWS) throw badRequest(m('importAi.tooMany', { max: AI_IMPORT_MAX_ROWS }));
  let mapping: AiMapping = given ?? guessMapping(headers);
  if (!given) {
    const used = new Set(Object.values(mapping));
    const idx = headers.findIndex((h, i) => !used.has(i) && CONFIDENTIAL_HEADERS.includes(lc(h)));
    if (idx >= 0) mapping = { ...mapping, confidential: idx };
  }
  if (mapping.title === undefined) throw badRequest(m('pilot.importTitle'), { headers, mapping });
  return { headers, mapping, data: rest };
}

const fieldsChanged = (o: PreviewRow['original'], s: Omit<CleanedRow, 'row'>): CleanField[] =>
  CLEAN_FIELDS.filter((f) => (f === 'topic' ? (s.topic ?? '') !== o.topic : s[f] !== o[f]));

/** Checks and repairs an AI answer for one row: topic only from the list, title within limits. */
function acceptSuggestion(raw: CleanedRow, o: PreviewRow['original'], topics: string[]): Omit<CleanedRow, 'row'> {
  const parsed = cleanedRowSchema.parse(raw);
  const title = parsed.title.trim().length >= 3 && parsed.title.trim().length <= TITLE_MAX ? parsed.title.trim() : o.title.slice(0, TITLE_MAX);
  return {
    title,
    problem: parsed.problem.slice(0, 5000),
    solution: parsed.solution.slice(0, 5000),
    benefit: parsed.benefit.slice(0, 3000),
    topic: parsed.topic && topics.includes(parsed.topic) ? parsed.topic : null,
    changes: parsed.changes,
  };
}

export async function previewImport(ctx: Ctx, filename: string, data: Buffer, given?: AiMapping): Promise<PreviewResult> {
  const { headers, mapping, data: rows } = await readRows(filename, data, given);
  const cell = (r: string[], f: AiImportField) => (mapping[f] === undefined ? '' : (r[mapping[f]!] ?? '').trim());
  const topics = ctx.settings.topics;
  const users = new Set((await ctx.db.query<{ email: string }>('SELECT lower(email) AS email FROM users WHERE active')).rows.map((u) => u.email));
  const existing = new Set((await ctx.db.query<{ t: string }>("SELECT lower(title) AS t FROM ideas WHERE status <> 'draft'")).rows.map((r) => r.t));

  const out: PreviewRow[] = rows.map((r, i) => ({
    row: i + 2,
    original: { title: cell(r, 'title'), problem: cell(r, 'problem'), solution: cell(r, 'solution'), benefit: cell(r, 'benefit'), topic: cell(r, 'topic') },
    suggestion: null,
    confidential: YES.has(lc(cell(r, 'confidential'))),
    email: cell(r, 'email'),
    authorKnown: users.has(lc(cell(r, 'email'))),
    duplicate: null,
    similar: [],
    include: true,
    skipReason: null,
  }));

  // AI cleanup through the gateway, in batches; confidential rows in batches of their own.
  const ai: PreviewResult['ai'] = { used: false, batches: 0, errors: [], actionIds: [] };
  for (const sensitive of [false, true]) {
    const part = out.filter((r) => r.confidential === sensitive);
    for (let i = 0; i < part.length; i += BATCH) {
      const batch = part.slice(i, i + BATCH);
      const raw: RawRow[] = batch.map((r) => ({ row: r.row, ...r.original }));
      ai.batches++;
      try {
        const run = await runAgent(ctx, importCleanupCall(raw, topics, sensitive));
        ai.used = true;
        ai.actionIds.push(run.actionId);
        const byRow = new Map(run.output.rows.map((x) => [x.row, x]));
        for (const r of batch) {
          const x = byRow.get(r.row);
          if (!x) continue;
          const s = acceptSuggestion(x, r.original, topics);
          const fields = fieldsChanged(r.original, s);
          r.suggestion = { ...s, fields };
        }
      } catch (err) {
        if (!(err instanceof AiError)) throw err;
        const text = errorText(ctx.locale, err);
        if (!ai.errors.includes(text)) ai.errors.push(text);
      }
    }
  }

  // Duplicate check: same title in the portal, same title earlier in the file, similar ideas.
  const seen = new Map<string, number>();
  for (const r of out) {
    const title = (r.suggestion?.title ?? r.original.title).trim();
    if (title.length < 3) {
      r.include = false;
      r.skipReason = 'title';
      continue;
    }
    const keys = [lc(title), lc(r.original.title)].filter(Boolean);
    if (keys.some((k) => existing.has(k))) r.duplicate = { kind: 'portal' };
    else {
      const first = keys.map((k) => seen.get(k)).find((n) => n !== undefined);
      if (first !== undefined) r.duplicate = { kind: 'file', row: first };
    }
    for (const k of keys) if (!seen.has(k)) seen.set(k, r.row);
    const s = r.suggestion ?? r.original;
    r.similar = (await findSimilar(ctx, `${title}\n${s.problem}\n${s.solution}`, { limit: 3 })).items;
    if (r.duplicate) {
      r.include = false;
      r.skipReason = 'duplicate';
    } else if (r.similar.some((x) => x.score >= SKIP_SIMILARITY)) {
      r.include = false;
      r.skipReason = 'similar';
    }
  }

  return {
    filename,
    headers,
    mapping,
    rows: out,
    ai,
    report: {
      total: out.length,
      included: out.filter((r) => r.include).length,
      duplicates: out.filter((r) => r.duplicate).length,
      similar: out.filter((r) => r.similar.length).length,
      confidential: out.filter((r) => r.confidential).length,
      suggestions: out.filter((r) => r.suggestion?.fields.length).length,
      unknownAuthors: out.filter((r) => !r.authorKnown).length,
    },
  };
}

// ---------------------------------------------------------------- commit after confirmation

export const commitRowSchema = z.object({
  row: z.number().int().min(1),
  title: z.string().trim().min(3).max(TITLE_MAX),
  problem: z.string().trim().max(5000).default(''),
  solution: z.string().trim().max(5000).default(''),
  benefit: z.string().trim().max(3000).default(''),
  topic: z.string().trim().max(80).nullable().default(null),
  email: z.string().trim().max(200).default(''),
  confidential: z.boolean().default(false),
  /** Fields whose AI suggestion the person took over; marked in the history of the idea. */
  aiFields: z.array(z.enum(CLEAN_FIELDS)).max(CLEAN_FIELDS.length).default([]),
});
export const commitSchema = z.object({
  filename: z.string().min(1).max(200),
  rows: z.array(commitRowSchema).min(1).max(AI_IMPORT_MAX_ROWS),
  actionIds: z.array(z.uuid()).max(100).default([]),
});
export type CommitInput = z.infer<typeof commitSchema>;

export async function commitImport(ctx: Ctx, body: CommitInput): Promise<{ imported: number; ideas: { row: number; id: string; number: number }[]; duplicates: number[]; aiMarked: number }> {
  const topics = ctx.settings.topics;
  const users = new Map((await ctx.db.query<{ id: string; email: string }>('SELECT id, lower(email) AS email FROM users WHERE active')).rows.map((u) => [u.email, u.id]));
  const seen = new Set((await ctx.db.query<{ t: string }>("SELECT lower(title) AS t FROM ideas WHERE status <> 'draft'")).rows.map((r) => r.t));
  // Only log entries of this workspace's import agent count as proof of the AI suggestion.
  const actions = body.actionIds.length
    ? (await ctx.db.query<{ id: string }>(`SELECT id FROM ai_actions WHERE id = ANY($1::uuid[]) AND agent = 'import_cleanup'`, [body.actionIds])).rows.map((r) => r.id)
    : [];
  const result = { imported: 0, ideas: [] as { row: number; id: string; number: number }[], duplicates: [] as number[], aiMarked: 0 };
  for (const r of body.rows) {
    if (seen.has(lc(r.title))) {
      result.duplicates.push(r.row);
      continue;
    }
    seen.add(lc(r.title));
    const authorId = users.get(lc(r.email));
    const topic = r.topic && topics.includes(r.topic) ? r.topic : null;
    const idea = await createIdea(ctx, ideaInput.parse({ title: r.title, problem: r.problem, solution: r.solution, benefit: r.benefit, topic, confidential: r.confidential }), authorId);
    await ctx.db.query(`UPDATE ideas SET status = 'submitted', submitted_at = now(), imported = true, author_confirmed = true WHERE id = $1`, [idea.id]);
    const base = m(authorId ? 'pilot.event.imported' : 'pilot.event.importedUnknownAuthor', { file: body.filename, row: r.row });
    const aiFields = r.aiFields.filter((f) => f !== 'topic' || topic);
    const message = aiFields.length
      ? cat([base, m('importAi.event.ai', { fields: tr('de', cat(aiFields.map((f) => m(`importAi.field.${f}` as MessageKey)), ', ')) })], ' ')
      : base;
    await ctx.db.query(
      `INSERT INTO idea_events (tenant_id, idea_id, actor_id, kind, from_status, to_status, message) VALUES ($1, $2, $3, 'imported', 'draft', 'submitted', $4)`,
      [ctx.tenantId, idea.id, ctx.user!.id, tr('de', message)],
    );
    await startDeadline(ctx, await loadIdea(ctx, idea.id), 'gate1', ctx.settings.deadlines.gate1Workdays);
    if (aiFields.length) result.aiMarked++;
    result.imported++;
    result.ideas.push({ row: r.row, id: idea.id, number: idea.number });
  }
  await audit(ctx, 'ideas.import', 'tenant', ctx.tenantId, null, {
    filename: body.filename, ai: true, total: body.rows.length, imported: result.imported, duplicates: result.duplicates, aiMarked: result.aiMarked, actionIds: actions,
  });
  return result;
}
