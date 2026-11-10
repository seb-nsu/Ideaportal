import { useState } from 'react';
import { api } from '../api';
import { ErrorBox, Field, readBase64, useAction } from '../components';
import { ROLES } from '../labels';
import { labelMap, t } from '../i18n';
import { hasRole, useSession } from '../session';

// People administration without SCIM (enterprise): CSV import with preview and confirmation,
// bulk actions for the selected people. Open to admins and the role "user_admin".

interface ImportRow {
  row: number;
  email: string;
  name: string;
  roles: string[];
  orgUnit: string | null;
  area: string | null;
  action: 'create' | 'update' | 'skip';
  errors: string[];
}

interface ImportResult {
  dryRun: boolean;
  rows: ImportRow[];
  summary: { total: number; create: number; update: number; skip: number };
  inviteLinks?: string[];
}

const ACTIONS = labelMap('ent.people.action', ['create', 'update', 'skip'] as const);

export function PeopleImport({ onDone }: { onDone: () => void }) {
  const [file, setFile] = useState<{ name: string; data: string } | null>(null);
  const [preview, setPreview] = useState<ImportResult | null>(null);
  const [done, setDone] = useState<ImportResult | null>(null);
  const { busy, error, run } = useAction();

  const choose = async (f: File | undefined) => {
    setPreview(null);
    setDone(null);
    if (!f) return setFile(null);
    const data = await readBase64(f);
    setFile({ name: f.name, data });
    const r = await run(() => api.post<ImportResult>('/api/admin/users/import', { filename: f.name, data, dryRun: true }));
    if (r) setPreview(r);
  };
  const confirm = async () => {
    const r = await run(() => api.post<ImportResult>('/api/admin/users/import', { filename: file!.name, data: file!.data, dryRun: false }));
    if (r) {
      setDone(r);
      setPreview(null);
      onDone();
    }
  };

  return (
    <section className="card stack" aria-labelledby="h-people-import">
      <h2 id="h-people-import">{t('ent.people.importTitle')}</h2>
      <p className="small muted">{t('ent.people.importHint')}</p>
      <ErrorBox error={error} />
      <Field id="people-file" label={t('ent.people.file')}>
        <input id="people-file" type="file" accept=".csv,.xlsx,.txt" onChange={(e) => void choose(e.target.files?.[0])} />
      </Field>
      {preview && (
        <>
          <p role="status">{t('ent.people.summary', preview.summary)}</p>
          <div className="table-wrap" tabIndex={0}>
            <table>
              <thead>
                <tr>
                  <th scope="col">{t('ent.people.col.row')}</th>
                  <th scope="col">{t('ent.people.col.person')}</th>
                  <th scope="col">{t('ent.people.col.roles')}</th>
                  <th scope="col">{t('ent.people.col.result')}</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((r) => (
                  <tr key={r.row}>
                    <td>{r.row}</td>
                    <td>
                      {r.name}
                      <div className="small muted">
                        {r.email}
                        {r.orgUnit ? ` · ${r.orgUnit}` : ''}
                        {r.area ? ` · ${r.area}` : ''}
                      </div>
                    </td>
                    <td className="small">{r.roles.map((x) => ROLES[x] ?? x).join(', ')}</td>
                    <td className="small">
                      <span className={`badge ${r.action === 'skip' ? 'red' : 'green'}`}>{ACTIONS[r.action]}</span>
                      {r.errors.length > 0 && <div>{r.errors.join(' · ')}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="row">
            <button type="button" className="primary" disabled={busy || preview.summary.create + preview.summary.update === 0} onClick={() => void confirm()}>
              {t('ent.people.confirm', { n: preview.summary.create + preview.summary.update })}
            </button>
            <button type="button" onClick={() => setPreview(null)}>
              {t('common.cancel')}
            </button>
          </div>
        </>
      )}
      {done && (
        <div className="alert success" role="status">
          {t('ent.people.done', done.summary)}
          {done.inviteLinks && (
            <pre className="small" style={{ whiteSpace: 'pre-wrap' }}>
              {done.inviteLinks.join('\n')}
            </pre>
          )}
        </div>
      )}
    </section>
  );
}

const BULK = ['deactivate', 'activate', 'addRole', 'removeRole'] as const;
type Bulk = (typeof BULK)[number];
const BULK_LABELS = labelMap('ent.bulk', BULK);

export function BulkBar({ selected, onDone }: { selected: string[]; onDone: () => void }) {
  const { me } = useSession();
  const [action, setAction] = useState<Bulk>('addRole');
  const [role, setRole] = useState('mentor');
  const [result, setResult] = useState<{ updated: number; skipped: { id: string; reason: string }[] } | null>(null);
  const { busy, error, run } = useAction();
  const roleChoices = Object.keys(ROLES).filter((r) => r !== 'submitter' && r !== 'external' && (r !== 'admin' || hasRole(me, 'admin')));
  const apply = async () => {
    if (action === 'deactivate' && !window.confirm(t('ent.bulk.confirmDeactivate', { n: selected.length }))) return;
    const r = await run(() =>
      api.post<{ updated: number; skipped: { id: string; reason: string }[] }>('/api/admin/users/bulk', {
        userIds: selected,
        action,
        role: action === 'addRole' || action === 'removeRole' ? role : undefined,
      }),
    );
    if (r) {
      setResult(r);
      onDone();
    }
  };
  return (
    <div className="card stack" role="region" aria-label={t('ent.bulk.region')}>
      <ErrorBox error={error} />
      <div className="row">
        <strong>{t('ent.bulk.selected', { n: selected.length })}</strong>
        <label className="sr-only" htmlFor="bulk-action">
          {t('ent.bulk.actionLabel')}
        </label>
        <select id="bulk-action" value={action} onChange={(e) => setAction(e.target.value as Bulk)}>
          {BULK.map((a) => (
            <option key={a} value={a}>
              {BULK_LABELS[a]}
            </option>
          ))}
        </select>
        {(action === 'addRole' || action === 'removeRole') && (
          <>
            <label className="sr-only" htmlFor="bulk-role">
              {t('ent.bulk.roleLabel')}
            </label>
            <select id="bulk-role" value={role} onChange={(e) => setRole(e.target.value)}>
              {roleChoices.map((r) => (
                <option key={r} value={r}>
                  {ROLES[r]}
                </option>
              ))}
            </select>
          </>
        )}
        <button type="button" className="primary" disabled={busy || !selected.length} onClick={() => void apply()}>
          {t('ent.bulk.apply')}
        </button>
      </div>
      {result && (
        <p className="small" role="status">
          {t('ent.bulk.result', { updated: result.updated, skipped: result.skipped.length })}
        </p>
      )}
    </div>
  );
}
