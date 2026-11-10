import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { ErrorBox, Field, Loading, useAction, useLoad } from '../components';
import { formatDateTime, t } from '../i18n';

// Support access (R3-07): the admins of the workspace decide whether and how long the
// operator's support may see the data of this workspace. Every access is listed here.

interface Grant {
  id: string;
  reason: string;
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
  grantedBy: string | null;
  revokedBy: string | null;
}

interface SupportAccessData {
  active: { id: string; expiresAt: string; reason: string } | null;
  grants: Grant[];
  accesses: { id: number; createdAt: string; operator: string | null; grantId: string | null }[];
}

const DURATIONS = [1, 4, 24, 72, 168];

export function SupportAccess() {
  const { data, error, loading, reload } = useLoad<SupportAccessData>('/api/admin/support-access');
  const [hours, setHours] = useState(4);
  const [reason, setReason] = useState('');
  const { busy, error: saveError, run } = useAction();
  if (loading && !data) return <Loading />;
  if (!data) return <ErrorBox error={error} />;

  const grant = async (e: FormEvent) => {
    e.preventDefault();
    if (await run(() => api.post('/api/admin/support-access', { hours, reason }))) {
      setReason('');
      await reload();
    }
  };
  const revoke = async () => {
    if (await run(() => api.del('/api/admin/support-access'))) await reload();
  };

  return (
    <div className="stack">
      <section className="card stack" aria-labelledby="support-title">
        <h2 id="support-title">{t('saas.support.title')}</h2>
        <p className="muted">{t('saas.support.intro')}</p>
        <ErrorBox error={saveError} />
        {data.active ? (
          <div className="alert info" role="status">
            <p>{t('saas.support.active', { time: formatDateTime(data.active.expiresAt), reason: data.active.reason })}</p>
            <button type="button" onClick={revoke} disabled={busy}>{t('saas.support.revoke')}</button>
          </div>
        ) : (
          <p><span className="badge">{t('saas.support.none')}</span></p>
        )}
        <form onSubmit={grant}>
          <div className="grid grid-2">
            <Field id="support-hours" label={t('saas.support.duration')}>
              <select id="support-hours" value={hours} onChange={(e) => setHours(Number(e.target.value))}>
                {DURATIONS.map((h) => <option key={h} value={h}>{t('saas.support.hours', { n: h })}</option>)}
              </select>
            </Field>
            <Field id="support-reason" label={t('saas.support.reason')} hint={t('saas.support.reasonHint')}>
              <input id="support-reason" value={reason} onChange={(e) => setReason(e.target.value)} required minLength={3} maxLength={300} />
            </Field>
          </div>
          <button className="primary" disabled={busy}>{data.active ? t('saas.support.replace') : t('saas.support.grant')}</button>
        </form>
      </section>

      <section className="card" aria-labelledby="support-accesses">
        <h2 id="support-accesses">{t('saas.support.accesses')}</h2>
        {data.accesses.length ? (
          <ul className="small">
            {data.accesses.map((a) => <li key={a.id}>{formatDateTime(a.createdAt)} · {t('saas.support.accessBy', { operator: a.operator ?? '–' })}</li>)}
          </ul>
        ) : <p className="muted">{t('saas.support.noAccesses')}</p>}
      </section>

      <section className="card" aria-labelledby="support-grants">
        <h2 id="support-grants">{t('saas.support.history')}</h2>
        {data.grants.length ? (
          <ul className="small">
            {data.grants.map((g) => (
              <li key={g.id}>
                {t('saas.support.grantLine', { time: formatDateTime(g.createdAt), by: g.grantedBy ?? '–', until: formatDateTime(g.expiresAt), reason: g.reason })}
                {g.revokedAt && ` ${t('saas.support.revokedLine', { time: formatDateTime(g.revokedAt), by: g.revokedBy ?? '–' })}`}
              </li>
            ))}
          </ul>
        ) : <p className="muted">{t('saas.support.noGrants')}</p>}
      </section>
    </div>
  );
}
