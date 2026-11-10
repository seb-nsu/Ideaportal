import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { Dialog, ErrorBox, Field, Loading, useAction, useLoad } from '../components';
import { formatDateTime, formatNumber, labelMap, t } from '../i18n';
import { useSession } from '../session';

// Enterprise: full export as ZIP (background job) and offboarding of the workspace with
// re-authentication and grace period, under Einstellungen › Daten.

interface ExportRow {
  id: string;
  status: 'queued' | 'running' | 'done' | 'failed' | 'expired';
  createdAt: string;
  finishedAt: string | null;
  expiresAt: string | null;
  sizeBytes: number | null;
  sha256: string | null;
  error: string | null;
  downloads: number;
  requestedBy: string | null;
  files: number | null;
}

interface Lifecycle {
  status: 'active' | 'suspended' | 'deleting';
  deletionRequestedAt: string | null;
  deleteAfter: string | null;
  deletionRequestedBy: string | null;
  deletionByOperator: boolean;
  graceDays: number;
  reauth: 'password' | 'password_totp' | 'sso';
  ssoMaxAgeMinutes: number;
  exportRetentionDays: number;
}

const EXPORT_STATUS = labelMap('ent.export.status', ['queued', 'running', 'done', 'failed', 'expired'] as const);

const megabytes = (n: number | null) => (n == null ? '–' : formatNumber(Math.max(0.01, n / 1024 / 1024), 2));

export function TenantExport() {
  const { data, error, loading, reload } = useLoad<ExportRow[]>('/api/admin/exports');
  const lc = useLoad<Lifecycle>('/api/admin/workspace/lifecycle');
  const { busy, error: startError, run } = useAction();
  const start = async () => {
    if (await run(() => api.post('/api/admin/exports'))) await reload();
  };
  const open = data?.some((e) => e.status === 'queued' || e.status === 'running');
  return (
    <section className="stack" aria-labelledby="h-export">
      <h2 id="h-export">{t('ent.export.title')}</h2>
      <p>{t('ent.export.text', { days: lc.data?.exportRetentionDays ?? 7 })}</p>
      <ErrorBox error={startError ?? error} />
      <div className="row">
        <button type="button" className="primary" disabled={busy || open} onClick={() => void start()}>
          {t('ent.export.start')}
        </button>
        <button type="button" onClick={() => void reload()}>
          {t('ent.export.reload')}
        </button>
      </div>
      {open && (
        <p className="small muted" role="status">
          {t('ent.export.running')}
        </p>
      )}
      {loading && !data ? (
        <Loading />
      ) : (
        data &&
        data.length > 0 && (
          <div className="table-wrap" tabIndex={0}>
            <table>
              <thead>
                <tr>
                  <th scope="col">{t('ent.export.col.created')}</th>
                  <th scope="col">{t('ent.export.col.status')}</th>
                  <th scope="col">{t('ent.export.col.size')}</th>
                  <th scope="col">{t('ent.export.col.action')}</th>
                </tr>
              </thead>
              <tbody>
                {data.map((e) => (
                  <tr key={e.id}>
                    <td className="small">
                      {formatDateTime(e.createdAt)}
                      <div className="muted">{e.requestedBy ?? '–'}</div>
                    </td>
                    <td>
                      <span className={`badge ${e.status === 'done' ? 'green' : e.status === 'failed' ? 'red' : e.status === 'expired' ? '' : 'yellow'}`}>
                        {EXPORT_STATUS[e.status]}
                      </span>
                      {e.status === 'done' && e.expiresAt && <div className="small muted">{t('ent.export.until', { time: formatDateTime(e.expiresAt) })}</div>}
                      {e.error && <div className="small muted">{e.error}</div>}
                    </td>
                    <td className="small">{t('ent.export.size', { mb: megabytes(e.sizeBytes), files: e.files ?? 0 })}</td>
                    <td>
                      {e.status === 'done' && (
                        <a className="button" href={`/api/admin/exports/${e.id}/download`} download>
                          {t('ent.export.download')}
                        </a>
                      )}
                      {e.sha256 && (
                        <div className="small muted" title={e.sha256}>
                          {t('ent.export.checksum', { hash: e.sha256.slice(0, 12) })}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}
      <p className="small muted">
        {t('ent.export.legacy')}{' '}
        <a href="/api/admin/export" download="ideenportal-export.json">
          {t('ent.export.legacyLink')}
        </a>
      </p>
    </section>
  );
}

export function Offboarding() {
  const { me } = useSession();
  const { data, error, reload } = useLoad<Lifecycle>('/api/admin/workspace/lifecycle');
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ confirm: '', password: '', code: '', slug: '', reason: '' });
  const { busy, error: actionError, run } = useAction();
  if (me.demo) return null;
  if (!data) return <ErrorBox error={error} />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const body = {
      confirm: form.confirm,
      reason: form.reason || undefined,
      ...(data.reauth === 'sso' ? { slug: form.slug } : { password: form.password, code: data.reauth === 'password_totp' ? form.code : undefined }),
    };
    if (await run(() => api.post('/api/admin/workspace/delete', body))) {
      setOpen(false);
      setForm({ confirm: '', password: '', code: '', slug: '', reason: '' });
      await reload();
    }
  };
  const cancel = async () => {
    if (await run(() => api.post('/api/admin/workspace/delete/cancel'))) window.location.reload();
  };

  if (data.status === 'deleting') {
    return (
      <div className="danger-zone stack" role="status">
        <h2>{t('ent.off.pendingTitle')}</h2>
        <p>
          {t('ent.off.pendingText', { time: data.deleteAfter ? formatDateTime(data.deleteAfter) : '–' })}{' '}
          {data.deletionByOperator ? t('ent.off.byOperator') : data.deletionRequestedBy ? t('ent.off.byAdmin', { name: data.deletionRequestedBy }) : ''}
        </p>
        <p className="small">{t('ent.off.pendingHint')}</p>
        <ErrorBox error={actionError} />
        <div>
          <button type="button" className="primary" disabled={busy} onClick={() => void cancel()}>
            {t('ent.off.cancel')}
          </button>
        </div>
      </div>
    );
  }

  const ok =
    form.confirm.trim() === me.tenant.name &&
    (data.reauth === 'sso' ? form.slug.trim() === me.tenant.slug : form.password.length > 0 && (data.reauth !== 'password_totp' || form.code.length >= 6));
  return (
    <div className="danger-zone">
      <h2>{t('admin.delete.title')}</h2>
      <p>{t('ent.off.text', { days: data.graceDays })}</p>
      <button type="button" className="danger" onClick={() => setOpen(true)}>
        {t('admin.delete.button')}
      </button>
      {open && (
        <Dialog title={t('admin.delete.dialogTitle')} onClose={() => setOpen(false)}>
          <form onSubmit={submit} className="stack">
            <ErrorBox error={actionError} />
            <p>{t('ent.off.warning', { days: data.graceDays })}</p>
            <Field id="off-name" label={t('admin.delete.confirmLabel', { name: me.tenant.name })}>
              <input id="off-name" type="text" value={form.confirm} onChange={(e) => setForm({ ...form, confirm: e.target.value })} autoComplete="off" />
            </Field>
            {data.reauth === 'sso' ? (
              <>
                <p className="small">{t('ent.off.ssoHint', { minutes: data.ssoMaxAgeMinutes })}</p>
                <Field id="off-slug" label={t('ent.off.slugLabel', { slug: me.tenant.slug })}>
                  <input id="off-slug" type="text" value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value })} autoComplete="off" />
                </Field>
              </>
            ) : (
              <>
                <Field id="off-pw" label={t('ent.off.password')}>
                  <input
                    id="off-pw"
                    type="password"
                    value={form.password}
                    onChange={(e) => setForm({ ...form, password: e.target.value })}
                    autoComplete="current-password"
                  />
                </Field>
                {data.reauth === 'password_totp' && (
                  <Field id="off-code" label={t('ent.off.code')}>
                    <input
                      id="off-code"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      value={form.code}
                      onChange={(e) => setForm({ ...form, code: e.target.value })}
                    />
                  </Field>
                )}
              </>
            )}
            <Field id="off-reason" label={t('ent.off.reason')}>
              <input id="off-reason" type="text" maxLength={300} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
            </Field>
            <div className="row">
              <button type="button" onClick={() => setOpen(false)}>
                {t('common.cancel')}
              </button>
              <button className="danger" disabled={busy || !ok}>
                {t('ent.off.confirm')}
              </button>
            </div>
          </form>
        </Dialog>
      )}
    </div>
  );
}
