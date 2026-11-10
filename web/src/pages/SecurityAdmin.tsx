import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ApiError, api } from '../api';
import { ErrorBox, Field, Loading, useAction, useLoad } from '../components';
import { formatDateTime, t } from '../i18n';

// Audit log with filters, export, chain check and SIEM forwarding; login and session rules
// (docs/enterprise/sicherheit-und-beobachtbarkeit.md).

interface AuditEntry {
  id: number;
  seq: number;
  createdAt: string;
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
}

interface Filter {
  from: string;
  to: string;
  actor: string;
  action: string;
}

interface VerifyResult {
  ok: boolean;
  checked: number;
  firstSeq: number | null;
  lastSeq: number | null;
  broken: { id: number | null; seq: number; reason: 'gap' | 'prev_hash' | 'row_hash' | 'tail' } | null;
}

const URL_PLACEHOLDER = 'https://'; // texts-ok: technical scheme

const EMPTY: Filter = { from: '', to: '', actor: '', action: '' };

function query(f: Filter): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v.trim()) p.set(k, v.trim());
  return p.toString();
}

export function AuditLog() {
  const [draft, setDraft] = useState<Filter>(EMPTY);
  const [filter, setFilter] = useState<Filter>(EMPTY);
  const [items, setItems] = useState<AuditEntry[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const verify = useAction();
  const [verified, setVerified] = useState<VerifyResult | null>(null);

  const load = useCallback(async (f: Filter, cursor: string | null) => {
    setLoading(true);
    try {
      const q = query(f);
      const page = await api.get<{ items: AuditEntry[]; nextCursor: string | null }>(
        `/api/admin/audit?paged=true&limit=100${q ? `&${q}` : ''}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      );
      setItems((old) => (cursor ? [...old, ...page.items] : page.items));
      setNext(page.nextCursor);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('components.loadError'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(filter, null);
  }, [filter, load]);

  const apply = (e: FormEvent) => {
    e.preventDefault();
    setFilter({ ...draft });
  };
  const reset = () => {
    setDraft(EMPTY);
    setFilter(EMPTY);
  };
  const runVerify = async () => {
    const r = await verify.run(() => api.get<VerifyResult>('/api/admin/audit/verify'));
    if (r) setVerified(r);
  };
  const q = query(filter);

  return (
    <section className="card stack">
      <div className="row spread">
        <h2>{t('admin.audit.title')}</h2>
        <div className="row">
          <a className="button" href={`/api/admin/audit/export?format=csv${q ? `&${q}` : ''}`}>
            {t('security.audit.exportCsv')}
          </a>
          <a className="button" href={`/api/admin/audit/export?format=jsonl${q ? `&${q}` : ''}`}>
            {t('security.audit.exportJsonl')}
          </a>
          <button type="button" onClick={runVerify} disabled={verify.busy}>
            {t('security.audit.verify')}
          </button>
        </div>
      </div>
      <p className="small muted">{t('security.audit.hint')}</p>
      <ErrorBox error={verify.error} />
      {verified && (
        <div className={`alert ${verified.ok ? 'success' : 'error'}`} role="status">
          {verified.ok
            ? t('security.audit.verifyOk', { n: verified.checked, from: verified.firstSeq ?? 0, to: verified.lastSeq ?? 0 })
            : t('security.audit.verifyBroken', { seq: verified.broken?.seq ?? 0, reason: t(`security.audit.reason.${verified.broken?.reason ?? 'row_hash'}`) })}
        </div>
      )}
      <form className="grid grid-3" onSubmit={apply} aria-label={t('security.audit.filter')}>
        <Field id="audit-from" label={t('security.audit.from')}>
          <input id="audit-from" type="date" value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })} />
        </Field>
        <Field id="audit-to" label={t('security.audit.to')}>
          <input id="audit-to" type="date" value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} />
        </Field>
        <Field id="audit-actor" label={t('security.audit.actor')} hint={t('security.audit.actorHint')}>
          <input
            id="audit-actor"
            type="text"
            value={draft.actor}
            maxLength={200}
            aria-describedby="audit-actor-hint"
            onChange={(e) => setDraft({ ...draft, actor: e.target.value })}
          />
        </Field>
        <Field id="audit-action" label={t('security.audit.action')} hint={t('security.audit.actionHint')}>
          <input
            id="audit-action"
            type="text"
            value={draft.action}
            maxLength={80}
            pattern="[A-Za-z0-9_.]*"
            aria-describedby="audit-action-hint"
            onChange={(e) => setDraft({ ...draft, action: e.target.value })}
          />
        </Field>
        <div className="row" style={{ alignSelf: 'end' }}>
          <button type="submit" className="primary">
            {t('security.audit.apply')}
          </button>
          <button type="button" onClick={reset}>
            {t('security.audit.reset')}
          </button>
        </div>
      </form>
      <ErrorBox error={error} />
      {loading && !items.length ? (
        <Loading />
      ) : (
        <div className="table-wrap" tabIndex={0}>
          <table>
            <thead>
              <tr>
                <th>{t('admin.audit.time')}</th>
                <th>{t('admin.audit.person')}</th>
                <th>{t('admin.audit.action')}</th>
                <th>{t('admin.audit.details')}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((a) => (
                <tr key={a.id}>
                  <td className="small">{formatDateTime(a.createdAt)}</td>
                  <td>{a.actorName ?? t('admin.audit.system')}</td>
                  <td>
                    <code>{a.action}</code>
                  </td>
                  <td className="small">
                    <details>
                      <summary>
                        {a.entity} {a.entityId?.slice(0, 8)}
                      </summary>
                      <dl className="small">
                        <dt>{t('security.audit.seq')}</dt>
                        <dd>{a.seq}</dd>
                        {a.requestId && (
                          <>
                            <dt>{t('security.audit.requestId')}</dt>
                            <dd>
                              <code>{a.requestId}</code>
                            </dd>
                          </>
                        )}
                        {a.ipHash && (
                          <>
                            <dt>{t('security.audit.ipHash')}</dt>
                            <dd>
                              <code>{a.ipHash}</code>
                            </dd>
                          </>
                        )}
                        {a.userAgent && (
                          <>
                            <dt>{t('security.audit.userAgent')}</dt>
                            <dd>{a.userAgent}</dd>
                          </>
                        )}
                      </dl>
                      <pre style={{ whiteSpace: 'pre-wrap' }}>
                        {JSON.stringify({ [t('admin.audit.before')]: a.before, [t('admin.audit.after')]: a.after }, null, 2)}
                      </pre>
                    </details>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!loading && !items.length && <p className="muted">{t('security.audit.empty')}</p>}
      {next && (
        <button type="button" onClick={() => load(filter, next)} disabled={loading}>
          {t('security.audit.more')}
        </button>
      )}
    </section>
  );
}

interface Siem {
  url: string;
  active: boolean;
  forwardedSeq: number;
  pending: number;
  failureCount: number;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastError: string | null;
}

export function SiemSettings() {
  const { data, error, loading, reload } = useLoad<{ siem: Siem | null }>('/api/admin/audit/siem');
  const { busy, error: actionError, run } = useAction();
  const [url, setUrl] = useState('');
  const [backfill, setBackfill] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const siem = data?.siem ?? null;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    const r = await run(() => api.put<{ secret: string }>('/api/admin/audit/siem', { url, backfill }));
    if (r) {
      setSecret(r.secret);
      setUrl('');
      await reload();
    }
  };
  const toggle = async () => {
    if (siem && (await run(() => api.patch('/api/admin/audit/siem', { active: !siem.active })))) await reload();
  };
  const rotate = async () => {
    const r = await run(() => api.post<{ secret: string }>('/api/admin/audit/siem/rotate'));
    if (r) setSecret(r.secret);
  };
  const remove = async () => {
    if (!window.confirm(t('security.siem.confirmDelete'))) return;
    if (await run(() => api.del('/api/admin/audit/siem'))) {
      setSecret(null);
      await reload();
    }
  };

  return (
    <section className="card stack">
      <h2>{t('security.siem.title')}</h2>
      <p className="small muted">{t('security.siem.hint')}</p>
      <ErrorBox error={error ?? actionError} />
      {secret && (
        <div className="alert success" role="status">
          <p>{t('security.siem.secret')}</p>
          <input type="text" readOnly value={secret} aria-label={t('security.siem.secret')} onFocus={(e) => e.target.select()} style={{ width: '100%' }} />
        </div>
      )}
      {loading && !data ? (
        <Loading />
      ) : siem ? (
        <div className="stack">
          <dl className="small">
            <dt>{t('security.siem.url')}</dt>
            <dd>
              <code>{siem.url}</code>
            </dd>
            <dt>{t('security.siem.state')}</dt>
            <dd>{siem.active ? t('security.siem.active') : t('security.siem.paused')}</dd>
            <dt>{t('security.siem.pending')}</dt>
            <dd>{siem.pending}</dd>
            {siem.lastSuccessAt && (
              <>
                <dt>{t('security.siem.lastSuccess')}</dt>
                <dd>{formatDateTime(siem.lastSuccessAt)}</dd>
              </>
            )}
            {siem.lastError && (
              <>
                <dt>{t('security.siem.lastError')}</dt>
                <dd>
                  <code>{siem.lastError}</code> ({siem.failureCount})
                </dd>
              </>
            )}
          </dl>
          <div className="row">
            <button type="button" onClick={toggle} disabled={busy}>
              {siem.active ? t('security.siem.pause') : t('security.siem.resume')}
            </button>
            <button type="button" onClick={rotate} disabled={busy}>
              {t('security.siem.rotate')}
            </button>
            <button type="button" className="danger" onClick={remove} disabled={busy}>
              {t('security.siem.delete')}
            </button>
          </div>
        </div>
      ) : null}
      <form className="stack" onSubmit={save}>
        <Field id="siem-url" label={siem ? t('security.siem.replace') : t('security.siem.url')} hint={t('security.siem.urlHint')}>
          <input
            id="siem-url"
            type="url"
            required
            value={url}
            maxLength={500}
            placeholder={URL_PLACEHOLDER}
            aria-describedby="siem-url-hint"
            onChange={(e) => setUrl(e.target.value)}
          />
        </Field>
        <label className="check">
          <input type="checkbox" checked={backfill} onChange={(e) => setBackfill(e.target.checked)} /> {t('security.siem.backfill')}
        </label>
        <div>
          <button type="submit" className="primary" disabled={busy}>
            {t('security.siem.save')}
          </button>
        </div>
      </form>
    </section>
  );
}

interface SettingsDoc {
  version?: number;
  security?: { passwordMinLength: number; sessionIdleMinutes: number };
  [key: string]: unknown;
}

export function SecuritySettings() {
  const { data, error, loading, setData, reload } = useLoad<SettingsDoc>('/api/admin/settings');
  const { busy, error: saveError, run } = useAction();
  const [saved, setSaved] = useState(false);
  if (loading && !data) return <Loading />;
  if (!data) return <ErrorBox error={error} />;
  const sec = data.security ?? { passwordMinLength: 10, sessionIdleMinutes: 0 };
  const update = (patch: Partial<typeof sec>) => {
    setSaved(false);
    setData({ ...data, security: { ...sec, ...patch } });
  };
  const save = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const r = await api.put<SettingsDoc>('/api/admin/settings', data);
      setData(r);
      setSaved(true);
    } catch (err) {
      // Concurrent change (409): show the message through useAction and load the current version.
      await run(async () => {
        throw err;
      });
      if (err instanceof ApiError && err.status === 409) await reload();
    }
  };
  return (
    <section className="card stack">
      <h2>{t('security.settings.title')}</h2>
      <form className="stack" onSubmit={save}>
        <div className="grid grid-3">
          <Field id="pw-min" label={t('security.settings.passwordMinLength')} hint={t('security.settings.passwordHint')}>
            <input
              id="pw-min"
              type="number"
              min={10}
              max={128}
              value={sec.passwordMinLength}
              aria-describedby="pw-min-hint"
              onChange={(e) => update({ passwordMinLength: Number(e.target.value) })}
            />
          </Field>
          <Field id="idle" label={t('security.settings.sessionIdleMinutes')} hint={t('security.settings.idleHint')}>
            <input
              id="idle"
              type="number"
              min={0}
              max={1440}
              value={sec.sessionIdleMinutes}
              aria-describedby="idle-hint"
              onChange={(e) => update({ sessionIdleMinutes: Number(e.target.value) })}
            />
          </Field>
        </div>
        <ErrorBox error={saveError} />
        {saved && (
          <p className="alert success" role="status">
            {t('security.settings.saved')}
          </p>
        )}
        <div>
          <button type="submit" className="primary" disabled={busy}>
            {t('security.settings.save')}
          </button>
        </div>
      </form>
    </section>
  );
}
