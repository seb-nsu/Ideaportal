import { Readable } from 'node:stream';
import { z } from 'zod';
import { withTenant } from '../db/pool.js';
import type { Ctx } from '../lib/context.js';
import { decodeCursor, encodeCursor, type Page } from '../lib/cursor.js';
import { m, tr, type Locale, type MessageKey } from '../i18n/index.js';

// Audit log view, export and verification (enterprise security). The log itself is written by
// services/audit.ts and the login routes; migration 031 adds request data and the hash chain.

const dateOrTime = z.union([z.iso.date(), z.iso.datetime({ offset: true })]);

export const auditFilterSchema = z.object({
  from: dateOrTime.optional(),
  to: dateOrTime.optional(),
  /** "system" (no person), a user id, or a part of a name or e-mail address. */
  actor: z.string().trim().max(200).optional(),
  /** Prefix of the action, e.g. "auth." or "settings.update". */
  action: z
    .string()
    .trim()
    .regex(/^[a-z0-9_.]*$/i)
    .max(80)
    .optional(),
});
export type AuditFilter = z.infer<typeof auditFilterSchema>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v);
const likeEscape = (v: string) => v.replace(/[\\%_]/g, (c) => `\\${c}`);

/** WHERE part for the filter; dates are calendar days in the tenant's time zone, "to" includes the day. */
export function auditWhere(f: AuditFilter, timezone: string, params: unknown[]): string {
  const parts: string[] = [];
  const add = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  if (f.from)
    parts.push(
      isDate(f.from) ? `a.created_at >= (${add(f.from)}::date)::timestamp AT TIME ZONE ${add(timezone)}` : `a.created_at >= ${add(f.from)}::timestamptz`,
    );
  if (f.to)
    parts.push(
      isDate(f.to) ? `a.created_at < ((${add(f.to)}::date + 1))::timestamp AT TIME ZONE ${add(timezone)}` : `a.created_at <= ${add(f.to)}::timestamptz`,
    );
  if (f.actor) {
    if (f.actor.toLowerCase() === 'system') parts.push('a.actor_id IS NULL');
    else if (UUID.test(f.actor)) parts.push(`a.actor_id = ${add(f.actor)}::uuid`);
    else {
      const p = add(`%${likeEscape(f.actor)}%`);
      parts.push(`(u.display_name ILIKE ${p} OR u.email ILIKE ${p})`);
    }
  }
  if (f.action) parts.push(`a.action LIKE ${add(`${likeEscape(f.action)}%`)}`);
  return parts.length ? parts.join(' AND ') : 'true';
}

export interface AuditRow {
  id: number;
  seq: number;
  createdAt: Date;
  actorId: string | null;
  actorName: string | null;
  actorEmail: string | null;
  action: string;
  entity: string;
  entityId: string | null;
  before: unknown;
  after: unknown;
  ipHash: string | null;
  userAgent: string | null;
  requestId: string | null;
  rowHash: string;
}

const COLUMNS = `a.id, a.chain_seq AS seq, a.created_at AS "createdAt", a.actor_id AS "actorId", u.display_name AS "actorName",
  u.email AS "actorEmail", a.action, a.entity, a.entity_id AS "entityId", a.before, a.after, a.ip_hash AS "ipHash",
  a.user_agent AS "userAgent", a.request_id AS "requestId", a.row_hash AS "rowHash"`;

/** One page, newest first, continued with the cursor of the previous page. */
export async function listAudit(ctx: Ctx, f: AuditFilter, limit: number, cursor?: string): Promise<Page<AuditRow>> {
  const params: unknown[] = [];
  let where = auditWhere(f, ctx.settings.timezone, params);
  if (cursor) {
    const [id] = decodeCursor(cursor, 'audit');
    params.push(Number(id));
    where += ` AND a.id < $${params.length}`;
  }
  params.push(limit + 1);
  const r = await ctx.db.query<AuditRow>(
    `SELECT ${COLUMNS} FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id WHERE ${where} ORDER BY a.id DESC LIMIT $${params.length}`,
    params,
  );
  const items = r.rows.slice(0, limit);
  return { items, nextCursor: r.rows.length > limit ? encodeCursor('audit', [items[items.length - 1].id]) : null };
}

const EXPORT_BATCH = 1000;

function csvCell(v: unknown): string {
  const s = v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v);
  // Formula injection: cells starting with = + - @ are prefixed for spreadsheet programs.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r;]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/**
 * Streams the whole filtered log (no row limit) as CSV or JSON Lines, oldest first. Every batch
 * runs in its own short tenant transaction, so a long download holds no transaction open.
 */
export function exportAudit(tenantId: string, locale: Locale, timezone: string, f: AuditFilter, format: 'csv' | 'jsonl'): Readable {
  async function* rows() {
    if (format === 'csv') {
      const head = ['time', 'person', 'action', 'object', 'id', 'before', 'after'].map((k) => tr(locale, m(`admin.auditCsv.${k}` as MessageKey)));
      const extra = ['seq', 'email', 'ipHash', 'userAgent', 'requestId', 'rowHash'].map((k) => tr(locale, m(`security.auditCsv.${k}` as MessageKey)));
      yield '﻿' + [...head, ...extra].map(csvCell).join(',') + '\r\n';
    }
    let after = 0;
    for (;;) {
      const batch = await withTenant(tenantId, async (db) => {
        const params: unknown[] = [];
        const where = auditWhere(f, timezone, params);
        params.push(after, EXPORT_BATCH);
        return (
          await db.query<AuditRow>(
            `SELECT ${COLUMNS} FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
            WHERE ${where} AND a.id > $${params.length - 1} ORDER BY a.id LIMIT $${params.length}`,
            params,
          )
        ).rows;
      });
      if (!batch.length) return;
      let chunk = '';
      for (const a of batch) {
        if (format === 'jsonl') {
          chunk += JSON.stringify({ ...a, createdAt: new Date(a.createdAt).toISOString() }) + '\n';
        } else {
          chunk +=
            [
              new Date(a.createdAt).toISOString(),
              a.actorName ?? tr(locale, m('admin.auditCsv.system')),
              a.action,
              a.entity,
              a.entityId,
              a.before == null ? '' : JSON.stringify(a.before),
              a.after == null ? '' : JSON.stringify(a.after),
              a.seq,
              a.actorEmail,
              a.ipHash,
              a.userAgent,
              a.requestId,
              a.rowHash,
            ]
              .map(csvCell)
              .join(',') + '\r\n';
        }
      }
      yield chunk;
      after = batch[batch.length - 1].id;
      if (batch.length < EXPORT_BATCH) return;
    }
  }
  return Readable.from(rows());
}

export type BrokenReason = 'gap' | 'prev_hash' | 'row_hash' | 'tail';

export interface VerifyResult {
  ok: boolean;
  checked: number;
  firstSeq: number | null;
  lastSeq: number | null;
  broken: { id: number | null; seq: number; reason: BrokenReason } | null;
}

/** Recomputes the hash chain of the tenant in the database (function audit_verify, migration 031). */
export async function verifyAudit(ctx: Ctx): Promise<VerifyResult> {
  const r = (
    await ctx.db.query<{
      ok: boolean;
      checked: number;
      first_seq: number | null;
      last_seq: number | null;
      broken_id: number | null;
      broken_seq: number | null;
      reason: BrokenReason;
    }>('SELECT * FROM audit_verify($1)', [ctx.tenantId])
  ).rows[0];
  return {
    ok: r.ok,
    checked: r.checked,
    firstSeq: r.first_seq,
    lastSeq: r.last_seq,
    broken: r.ok ? null : { id: r.broken_id, seq: r.broken_seq ?? 0, reason: r.reason },
  };
}
