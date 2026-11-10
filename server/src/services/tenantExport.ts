import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import yazl from 'yazl';
import { config } from '../config.js';
import { withSystem, withTenant, type Db } from '../db/pool.js';
import { buildCtx } from '../lib/context.js';
import { sanitizeFilename } from '../lib/attachments.js';
import { m } from '../i18n/index.js';
import { notifyUser } from './notify.js';

// Full export of a tenant (enterprise, replaces the synchronous JSON of R1-43 for large
// workspaces). An admin starts it; the export worker writes a ZIP with one CSV and one JSONL
// file per tenant table, the stored files (attachments and other binary columns) and a
// manifest.json with row counts and the schema version. The ZIP is kept in pieces of about
// 1 MB in tenant_export_chunks (the database also holds the attachments), so writing and the
// download stream. Everything is read through the tenant's row-level security: the export can
// only ever contain the own tenant's rows. Downloadable for EXPORT_RETENTION_DAYS days.

export const EXPORT_FORMAT_VERSION = 1;
const CHUNK_BYTES = 1024 * 1024;
const BATCH_ROWS = 500;
const BATCH_ROWS_FILES = 20;

/**
 * Tables never exported: sessions, keys, secrets, login states, the export itself and the mail
 * queue (it holds one-time links for invitations and password resets).
 */
const EXCLUDED_TABLES = new Set(['sessions', 'tenant_keys', 'tenant_secrets', 'oidc_login_states', 'tenant_exports', 'tenant_export_chunks', 'outbox']);
/** Columns with secrets or credentials (hashes, encrypted values) stay out of every file. */
const SECRET_COLUMN = /(^password_hash$|^mfa_secret$|token_hash$|^state_hash$|^browser_hash$|^link_code_hash$|^ciphertext$|^wrapped_key$|_enc$)/;
const IDENT = /^[a-z_][a-z0-9_]*$/;

interface Column {
  name: string;
  type: string;
}

interface TableInfo {
  name: string;
  columns: Column[];
  excluded: string[];
  fileColumns: string[];
  hasId: boolean;
  hasFilename: boolean;
}

/** Tenant tables the export reads, with the columns the app role may select. */
async function exportTables(db: Db): Promise<{ tables: TableInfo[]; skipped: string[] }> {
  const rows = (
    await db.query<{ table_name: string; column_name: string; data_type: string; can: boolean; table_ok: boolean }>(
      `SELECT c.table_name, c.column_name, c.data_type,
            has_column_privilege('ideenportal_app', format('public.%I', c.table_name), c.column_name, 'SELECT') AS can,
            has_table_privilege('ideenportal_app', format('public.%I', c.table_name), 'SELECT') AS table_ok
       FROM information_schema.columns c
       JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
      WHERE c.table_schema = 'public'
        AND c.table_name IN (SELECT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'tenant_id')
      ORDER BY c.table_name, c.ordinal_position`,
    )
  ).rows;
  const byTable = new Map<string, typeof rows>();
  for (const r of rows) byTable.set(r.table_name, [...(byTable.get(r.table_name) ?? []), r]);
  const tables: TableInfo[] = [];
  const skipped: string[] = [];
  for (const [name, cols] of byTable) {
    if (EXCLUDED_TABLES.has(name) || !IDENT.test(name)) continue;
    const readable = cols.filter((c) => c.can && IDENT.test(c.column_name));
    if (!readable.length || !cols.some((c) => c.column_name === 'tenant_id' && c.can)) {
      skipped.push(name);
      continue;
    }
    const excluded = cols.filter((c) => !c.can || SECRET_COLUMN.test(c.column_name)).map((c) => c.column_name);
    const columns = readable.filter((c) => !SECRET_COLUMN.test(c.column_name)).map((c) => ({ name: c.column_name, type: c.data_type }));
    tables.push({
      name,
      columns,
      excluded,
      fileColumns: columns.filter((c) => c.type === 'bytea').map((c) => c.name),
      hasId: columns.some((c) => c.name === 'id'),
      hasFilename: columns.some((c) => c.name === 'filename'),
    });
  }
  return { tables, skipped };
}

function filePath(table: string, column: string, id: string, filename: string | null): string {
  const name = filename ? sanitizeFilename(filename) : column;
  return `files/${table}/${id}/${name}`;
}

/** Text cell for CSV; formulas are neutralised for spreadsheet programs (the JSONL keeps the raw value). */
function csvCell(v: unknown): string {
  if (v == null) return '';
  let s = v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function selectList(t: TableInfo): string {
  // Binary columns are replaced by their length; the content goes into files/.
  return t.columns.map((c) => (c.type === 'bytea' ? `octet_length("${c.name}") AS "${c.name}"` : `"${c.name}"`)).join(', ');
}

/** Rows of a table in batches through a cursor of the export transaction. */
async function* tableRows(db: Db, t: TableInfo, cursor: string): AsyncGenerator<Record<string, unknown>[]> {
  const batch = t.fileColumns.length ? BATCH_ROWS_FILES : BATCH_ROWS;
  await db.query(`DECLARE ${cursor} NO SCROLL CURSOR FOR SELECT ${selectList(t)} FROM "${t.name}"${t.hasId ? ' ORDER BY "id"' : ''}`); // security-ok: identifiers from information_schema, checked against IDENT
  try {
    for (;;) {
      const r = await db.query(`FETCH ${batch} FROM ${cursor}`); // security-ok: fixed cursor name and number
      if (!r.rows.length) return;
      yield r.rows;
    }
  } finally {
    await db.query(`CLOSE ${cursor}`); // security-ok: fixed cursor name
  }
}

function withFilePaths(t: TableInfo, row: Record<string, unknown>): Record<string, unknown> {
  if (!t.fileColumns.length) return row;
  const out = { ...row };
  for (const col of t.fileColumns) {
    out[col] = row[col] == null || !t.hasId ? null : filePath(t.name, col, String(row.id), t.hasFilename ? (row.filename as string | null) : null);
  }
  return out;
}

interface Counts {
  rows: Record<string, number>;
  files: number;
  fileBytes: number;
}

async function* csvFile(db: Db, t: TableInfo, counts: Counts, n: number): AsyncGenerator<Buffer> {
  yield Buffer.from('﻿' + t.columns.map((c) => csvCell(c.name)).join(';') + '\n', 'utf8');
  let rows = 0;
  for await (const batch of tableRows(db, t, `exp_csv_${n}`)) {
    rows += batch.length;
    yield Buffer.from(
      batch
        .map((r) => {
          const x = withFilePaths(t, r);
          return t.columns.map((c) => csvCell(x[c.name])).join(';');
        })
        .join('\n') + '\n',
      'utf8',
    );
  }
  counts.rows[t.name] = rows;
}

async function* jsonlFile(db: Db, t: TableInfo, n: number): AsyncGenerator<Buffer> {
  for await (const batch of tableRows(db, t, `exp_jsonl_${n}`)) {
    yield Buffer.from(batch.map((r) => JSON.stringify(withFilePaths(t, r))).join('\n') + '\n', 'utf8');
  }
}

async function* fileContent(db: Db, t: TableInfo, column: string, id: string, counts: Counts): AsyncGenerator<Buffer> {
  const r = await db.query<{ data: Buffer | null }>(`SELECT "${column}" AS data FROM "${t.name}" WHERE "id" = $1`, [id]); // security-ok: identifiers from information_schema, checked against IDENT
  const data = r.rows[0]?.data;
  if (!data) return;
  counts.files++;
  counts.fileBytes += data.length;
  yield data;
}

/**
 * Writes the ZIP of one export into tenant_export_chunks. Runs in one tenant transaction:
 * the cursors read the tables while the consumer stores the output in chunks.
 */
async function buildZip(exportId: string, tenantId: string, schemaVersion: string): Promise<{ size: number; sha256: string; manifest: unknown }> {
  return withTenant(tenantId, async (db) => {
    const { tables, skipped } = await exportTables(db);
    const tenant = (
      await db.query<{ id: string; slug: string; name: string; settings: unknown; created_at: Date; status: string }>(
        'SELECT id, slug, name, settings, created_at, status FROM tenants WHERE id = $1',
        [tenantId],
      )
    ).rows[0];
    const counts: Counts = { rows: {}, files: 0, fileBytes: 0 };
    const zip = new yazl.ZipFile();
    const mtime = new Date();
    // yazl does not forward errors of entry streams: any error ends the output stream, so the
    // consumer below fails and the transaction rolls back.
    const fail = (err: Error) => (zip.outputStream as Readable).destroy(err);
    zip.on('error', fail);
    const stream = (gen: AsyncGenerator<Buffer>) => Readable.from(gen, { objectMode: false }).on('error', fail);
    zip.addBuffer(
      Buffer.from(JSON.stringify({ id: tenant.id, slug: tenant.slug, name: tenant.name, createdAt: tenant.created_at, settings: tenant.settings }, null, 2)),
      'tenant.json',
      { mtime },
    );
    tables.forEach((t, i) => {
      zip.addReadStream(stream(csvFile(db, t, counts, i)), `tables/${t.name}.csv`, { mtime });
      zip.addReadStream(stream(jsonlFile(db, t, i)), `tables/${t.name}.jsonl`, { mtime });
    });
    // Stored files: one entry per row and binary column (ids only here, contents while zipping).
    for (const t of tables.filter((x) => x.fileColumns.length && x.hasId)) {
      for (const col of t.fileColumns) {
        const ids = await db.query<{ id: string; filename: string | null }>(
          `SELECT "id"::text AS id, ${t.hasFilename ? '"filename"' : 'NULL::text'} AS filename FROM "${t.name}" WHERE "${col}" IS NOT NULL ORDER BY "id"`, // security-ok: identifiers from information_schema, checked against IDENT
        );
        for (const r of ids.rows)
          zip.addReadStream(stream(fileContent(db, t, col, r.id, counts)), filePath(t.name, col, r.id, r.filename), { mtime, compress: false });
      }
    }
    // The manifest is read last, when every count is known.
    const manifestHolder: { value: unknown } = { value: null };
    async function* manifestGen(): AsyncGenerator<Buffer> {
      const manifest = {
        format: 'ideenportal-tenant-export',
        formatVersion: EXPORT_FORMAT_VERSION,
        schemaVersion,
        exportedAt: new Date().toISOString(),
        exportId,
        tenant: { id: tenant.id, slug: tenant.slug, name: tenant.name },
        tables: Object.fromEntries(
          tables.map((t) => [
            t.name,
            {
              rows: counts.rows[t.name] ?? 0,
              csv: `tables/${t.name}.csv`,
              jsonl: `tables/${t.name}.jsonl`,
              columns: t.columns.map((c) => c.name),
              excludedColumns: t.excluded,
              fileColumns: t.fileColumns,
            },
          ]),
        ),
        excludedTables: [...EXCLUDED_TABLES].sort(),
        skippedTables: skipped,
        files: { count: counts.files, bytes: counts.fileBytes },
        notes: 'CSV: UTF-8 with BOM, separator ";", values starting with = + - @ are prefixed with an apostrophe. JSONL: raw values.',
      };
      manifestHolder.value = manifest;
      yield Buffer.from(JSON.stringify(manifest, null, 2));
    }
    zip.addReadStream(stream(manifestGen()), 'manifest.json', { mtime });
    zip.end();

    const hash = createHash('sha256');
    let seq = 0;
    let size = 0;
    let pending: Buffer[] = [];
    let pendingBytes = 0;
    const flush = async () => {
      if (!pendingBytes) return;
      const data = Buffer.concat(pending);
      pending = [];
      pendingBytes = 0;
      await db.query('INSERT INTO tenant_export_chunks (export_id, tenant_id, seq, data) VALUES ($1, $2, $3, $4)', [exportId, tenantId, seq++, data]);
    };
    for await (const chunk of zip.outputStream as AsyncIterable<Buffer>) {
      hash.update(chunk);
      size += chunk.length;
      pending.push(chunk);
      pendingBytes += chunk.length;
      if (pendingBytes >= CHUNK_BYTES) await flush();
    }
    await flush();
    const sha256 = hash.digest('hex');
    await db.query(
      `UPDATE tenant_exports SET status = 'done', finished_at = now(), expires_at = now() + make_interval(days => $2), size_bytes = $3, sha256 = $4, manifest = $5 WHERE id = $1`,
      [exportId, config.exportRetentionDays, size, sha256, JSON.stringify(manifestHolder.value)],
    );
    return { size, sha256, manifest: manifestHolder.value };
  });
}

/** Queues an export; one running or queued export per tenant at a time. */
export async function requestExport(db: Db, tenantId: string, userId: string): Promise<{ id: string; existing: boolean }> {
  const open = (await db.query<{ id: string }>(`SELECT id FROM tenant_exports WHERE status IN ('queued', 'running') ORDER BY created_at LIMIT 1`)).rows[0];
  if (open) return { id: open.id, existing: true };
  const id = (await db.query<{ id: string }>('INSERT INTO tenant_exports (tenant_id, requested_by) VALUES ($1, $2) RETURNING id', [tenantId, userId])).rows[0]
    .id;
  return { id, existing: false };
}

export async function listExports(db: Db) {
  return (
    await db.query(
      `SELECT e.id, e.status, e.created_at AS "createdAt", e.finished_at AS "finishedAt", e.expires_at AS "expiresAt", e.size_bytes AS "sizeBytes",
            e.sha256, e.error, e.downloads, u.display_name AS "requestedBy",
            (e.manifest->'files'->>'count')::int AS files
       FROM tenant_exports e LEFT JOIN users u ON u.id = e.requested_by ORDER BY e.created_at DESC LIMIT 20`,
    )
  ).rows;
}

/** Chunks of a finished export in order, each read in its own short tenant transaction. */
export async function* exportChunks(tenantId: string, exportId: string): AsyncGenerator<Buffer> {
  for (let seq = 0; ; seq++) {
    const r = await withTenant(tenantId, (db) =>
      db.query<{ data: Buffer }>('SELECT data FROM tenant_export_chunks WHERE export_id = $1 AND seq = $2', [exportId, seq]),
    );
    if (!r.rows[0]) return;
    yield r.rows[0].data;
  }
}

/**
 * Export worker: takes queued exports (not of suspended tenants), writes the ZIP, notifies the
 * requester. Also re-queues exports stuck after a crash and removes expired files.
 */
export async function processExports(max = 2): Promise<number> {
  await withSystem(async (c) => {
    await c.query(`UPDATE tenant_exports SET status = 'queued', started_at = NULL WHERE status = 'running' AND started_at < now() - interval '2 hours'`);
    const expired = await c.query<{ id: string }>(`UPDATE tenant_exports SET status = 'expired' WHERE status = 'done' AND expires_at <= now() RETURNING id`);
    if (expired.rowCount) await c.query('DELETE FROM tenant_export_chunks WHERE export_id = ANY($1::uuid[])', [expired.rows.map((r) => r.id)]);
  });
  const schemaVersion = await withSystem(
    async (c) => (await c.query<{ v: string | null }>('SELECT max(name) AS v FROM schema_migrations')).rows[0].v ?? 'unknown',
  );
  let done = 0;
  for (; done < max; done++) {
    const job = await withSystem(
      async (c) =>
        (
          await c.query<{ id: string; tenant_id: string; requested_by: string | null }>(
            `UPDATE tenant_exports SET status = 'running', started_at = now()
        WHERE id = (SELECT e.id FROM tenant_exports e JOIN tenants t ON t.id = e.tenant_id
                     WHERE e.status = 'queued' AND t.status <> 'suspended' ORDER BY e.created_at FOR UPDATE OF e SKIP LOCKED LIMIT 1)
        RETURNING id, tenant_id, requested_by`,
          )
        ).rows[0],
    );
    if (!job) break;
    try {
      const r = await buildZip(job.id, job.tenant_id, schemaVersion);
      await withTenant(job.tenant_id, async (db) => {
        const ctx = await buildCtx(db, job.tenant_id, null);
        await db.query('INSERT INTO audit_log (tenant_id, actor_id, action, entity, entity_id, after) VALUES ($1, $2, $3, $4, $5, $6)', [
          job.tenant_id,
          job.requested_by,
          'tenant.export_ready',
          'tenant_export',
          job.id,
          JSON.stringify({ size: r.size, sha256: r.sha256 }),
        ]);
        if (job.requested_by) {
          await notifyUser(
            ctx,
            job.requested_by,
            m('tenantlc.export.readySubject'),
            m('tenantlc.export.readyBody', { days: config.exportRetentionDays, url: `${config.publicUrl}/einstellungen?tab=data` }),
          );
        }
      });
    } catch (err) {
      await withSystem(async (c) => {
        await c.query('DELETE FROM tenant_export_chunks WHERE export_id = $1', [job.id]);
        await c.query(`UPDATE tenant_exports SET status = 'failed', finished_at = now(), error = $2 WHERE id = $1`, [
          job.id,
          String((err as Error).message ?? err).slice(0, 300),
        ]);
      });
    }
  }
  return done;
}
