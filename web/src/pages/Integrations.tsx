import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { ErrorBox, Field, Loading, useAction, useLoad } from '../components';
import { ROLES } from '../labels';
import { Connectors } from './Connectors';
import { formatDate, formatDateTime, labelMap, t } from '../i18n';

// Settings › Integrations (R3-17): API tokens and webhooks of the workspace.

interface ApiToken {
  id: string;
  name: string;
  prefix: string;
  roles: string[];
  expiresAt: string;
  lastUsedAt: string | null;
  createdBy: string | null;
  state: 'active' | 'expired' | 'revoked';
}

interface Webhook {
  id: string;
  name: string;
  url: string;
  events: string[];
  active: boolean;
  failureCount: number;
  disabledReason: string | null;
  pending: number;
}

interface Delivery {
  id: string;
  event: string;
  status: 'pending' | 'delivered' | 'failed';
  attempts: number;
  responseStatus: number | null;
  error: string | null;
  createdAt: string;
  nextAttemptAt: string;
}

const EVENTS = ['idea.submitted', 'idea.status_changed', 'idea.gate_decided', 'challenge.phase_changed'] as const;
const EXPIRY_DAYS = [30, 90, 180, 365];

export function Integrations() {
  return (
    <div className="stack">
      <section className="card">
        <p>{t('integrations.intro')}</p>
        <a href="/api/docs" target="_blank" rel="noopener">{t('integrations.docsLink')}</a>
      </section>
      <Tokens />
      <Webhooks />
      <Connectors />
    </div>
  );
}

/** A secret shown once, with a copy button. */
function OneTimeSecret({ text, value }: { text: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="alert success" role="status">
      <p>{text}</p>
      <div className="row">
        <input type="text" readOnly value={value} aria-label={text} onFocus={(e) => e.target.select()} style={{ flex: 1, minWidth: 220 }} />
        <button type="button" onClick={copy}>{copied ? t('integrations.tokens.copied') : t('integrations.tokens.copy')}</button>
      </div>
    </div>
  );
}

function Tokens() {
  const STATE = labelMap('integrations.tokens.state', ['active', 'expired', 'revoked'] as const);
  const { data, error, loading, reload } = useLoad<ApiToken[]>('/api/admin/api-tokens');
  const { busy, error: actionError, run } = useAction();
  const [form, setForm] = useState({ name: '', roles: ['submitter'], expiresInDays: 90, allowAdmin: false });
  const [created, setCreated] = useState<string | null>(null);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setCreated(null);
    const r = await run(() => api.post<{ token: string }>('/api/admin/api-tokens', form));
    if (r) {
      setCreated(r.token);
      setForm({ name: '', roles: ['submitter'], expiresInDays: 90, allowAdmin: false });
      reload();
    }
  };
  const revoke = async (tk: ApiToken) => {
    if (!window.confirm(t('integrations.tokens.revokeConfirm', { name: tk.name }))) return;
    if (await run(() => api.post(`/api/admin/api-tokens/${tk.id}/revoke`))) reload();
  };
  const toggleRole = (role: string, on: boolean) =>
    setForm({ ...form, roles: on ? [...form.roles, role] : form.roles.filter((r) => r !== role), allowAdmin: role === 'admin' && !on ? false : form.allowAdmin });

  return (
    <section className="card stack" aria-labelledby="h-tokens">
      <h2 id="h-tokens">{t('integrations.tokens.title')}</h2>
      <ErrorBox error={actionError} />
      {created && <OneTimeSecret text={t('integrations.tokens.created')} value={created} />}
      <form className="stack" onSubmit={create}>
        <div className="grid grid-3">
          <Field id="tk-name" label={t('integrations.tokens.name')} hint={t('integrations.tokens.nameHint')}>
            <input id="tk-name" type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required minLength={2} maxLength={80} aria-describedby="tk-name-hint" />
          </Field>
          <Field id="tk-expires" label={t('integrations.tokens.expires')}>
            <select id="tk-expires" value={form.expiresInDays} onChange={(e) => setForm({ ...form, expiresInDays: Number(e.target.value) })}>
              {EXPIRY_DAYS.map((d) => <option key={d} value={d}>{t('integrations.tokens.days', { n: d })}</option>)}
            </select>
          </Field>
        </div>
        <fieldset>
          <legend>{t('integrations.tokens.roles')}</legend>
          <div className="row">
            {Object.entries(ROLES).map(([k, v]) => (
              <label key={k} className="check">
                <input type="checkbox" checked={form.roles.includes(k)} onChange={(e) => toggleRole(k, e.target.checked)} /> {v}
              </label>
            ))}
          </div>
        </fieldset>
        {form.roles.includes('admin') && (
          <label className="check">
            <input type="checkbox" checked={form.allowAdmin} onChange={(e) => setForm({ ...form, allowAdmin: e.target.checked })} required /> {t('integrations.tokens.allowAdmin')}
          </label>
        )}
        <div><button className="primary" disabled={busy || form.roles.length === 0}>{t('integrations.tokens.create')}</button></div>
      </form>
      <h3>{t('integrations.tokens.list')}</h3>
      <ErrorBox error={error} />
      {loading && !data && <Loading />}
      {data?.length === 0 && <p className="muted">{t('integrations.tokens.empty')}</p>}
      {!!data?.length && (
        <div className="table-wrap" tabIndex={0}><table>
          <thead>
            <tr>
              <th>{t('integrations.tokens.colName')}</th><th>{t('integrations.tokens.colRoles')}</th><th>{t('integrations.tokens.colExpires')}</th>
              <th>{t('integrations.tokens.colUsed')}</th><th>{t('integrations.tokens.colState')}</th>
            </tr>
          </thead>
          <tbody>
            {data.map((tk) => (
              <tr key={tk.id}>
                <td><strong>{tk.name}</strong><div className="small muted"><code>ipt_{tk.prefix}_…</code>{tk.createdBy ? ` · ${tk.createdBy}` : ''}</div></td>
                <td className="small">{tk.roles.map((r) => ROLES[r] ?? r).join(', ')}</td>
                <td className="small">{formatDate(tk.expiresAt)}</td>
                <td className="small">{tk.lastUsedAt ? formatDateTime(tk.lastUsedAt) : t('integrations.tokens.never')}</td>
                <td className="small">
                  <span className={`badge ${tk.state === 'active' ? 'green' : 'red'}`}>{STATE[tk.state]}</span>{' '}
                  {tk.state === 'active' && (
                    <button type="button" className="link" disabled={busy} onClick={() => revoke(tk)} aria-label={t('integrations.tokens.revokeFor', { name: tk.name })}>{t('integrations.tokens.revoke')}</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
    </section>
  );
}

function Webhooks() {
  const EVENT_LABELS = labelMap('integrations.event', [...EVENTS, 'webhook.test'] as const);
  const { data, error, loading, reload } = useLoad<Webhook[]>('/api/admin/webhooks');
  const { busy, error: actionError, run } = useAction();
  const [form, setForm] = useState({ name: '', url: 'https://', events: ['idea.status_changed'] as string[] });
  const [secret, setSecret] = useState<{ text: string; value: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setSecret(null);
    setNotice(null);
    const r = await run(() => api.post<{ secret: string }>('/api/admin/webhooks', form));
    if (r) {
      setSecret({ text: t('integrations.hooks.created'), value: r.secret });
      setForm({ name: '', url: 'https://', events: ['idea.status_changed'] });
      reload();
    }
  };
  const toggle = async (w: Webhook) => {
    if (await run(() => api.patch(`/api/admin/webhooks/${w.id}`, { active: !w.active }))) reload();
  };
  const test = async (w: Webhook) => {
    if (await run(() => api.post(`/api/admin/webhooks/${w.id}/test`))) {
      setNotice(t('integrations.hooks.testQueued'));
      reload();
    }
  };
  const rotate = async (w: Webhook) => {
    if (!window.confirm(t('integrations.hooks.rotateConfirm', { name: w.name }))) return;
    const r = await run(() => api.post<{ secret: string }>(`/api/admin/webhooks/${w.id}/rotate-secret`));
    if (r) setSecret({ text: t('integrations.hooks.newSecret'), value: r.secret });
  };
  const remove = async (w: Webhook) => {
    if (!window.confirm(t('integrations.hooks.deleteConfirm', { name: w.name }))) return;
    if (await run(() => api.del(`/api/admin/webhooks/${w.id}`))) reload();
  };

  return (
    <section className="card stack" aria-labelledby="h-hooks">
      <h2 id="h-hooks">{t('integrations.hooks.title')}</h2>
      <p className="small muted">{t('integrations.hooks.hint')}</p>
      <ErrorBox error={actionError} />
      {secret && <OneTimeSecret text={secret.text} value={secret.value} />}
      {notice && <div className="alert success" role="status">{notice}</div>}
      <form className="stack" onSubmit={create}>
        <div className="grid grid-3">
          <Field id="wh-name" label={t('integrations.hooks.name')}>
            <input id="wh-name" type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required minLength={2} maxLength={80} />
          </Field>
          <Field id="wh-url" label={t('integrations.hooks.url')}>
            <input id="wh-url" type="url" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} required pattern="https://.*" />
          </Field>
        </div>
        <fieldset>
          <legend>{t('integrations.hooks.events')}</legend>
          <div className="row">
            {EVENTS.map((ev) => (
              <label key={ev} className="check">
                <input type="checkbox" checked={form.events.includes(ev)} onChange={(e) => setForm({ ...form, events: e.target.checked ? [...form.events, ev] : form.events.filter((x) => x !== ev) })} /> {EVENT_LABELS[ev]}
              </label>
            ))}
          </div>
        </fieldset>
        <div><button className="primary" disabled={busy || form.events.length === 0}>{t('integrations.hooks.create')}</button></div>
      </form>
      <h3>{t('integrations.hooks.list')}</h3>
      <ErrorBox error={error} />
      {loading && !data && <Loading />}
      {data?.length === 0 && <p className="muted">{t('integrations.hooks.empty')}</p>}
      {!!data?.length && (
        <div className="table-wrap" tabIndex={0}><table>
          <thead><tr><th>{t('integrations.hooks.colName')}</th><th>{t('integrations.hooks.colEvents')}</th><th>{t('integrations.hooks.colState')}</th></tr></thead>
          <tbody>
            {data.map((w) => (
              <tr key={w.id}>
                <td>
                  <strong>{w.name}</strong>
                  <div className="small muted"><code>{w.url}</code></div>
                  <button type="button" className="link" aria-expanded={open === w.id} onClick={() => setOpen(open === w.id ? null : w.id)} aria-label={t('integrations.hooks.deliveriesFor', { name: w.name })}>
                    {t('integrations.hooks.deliveries')}
                  </button>
                  {open === w.id && <Deliveries id={w.id} labels={EVENT_LABELS} />}
                </td>
                <td className="small">{w.events.map((ev) => EVENT_LABELS[ev] ?? ev).join(', ')}</td>
                <td className="small">
                  <span className={`badge ${w.active ? 'green' : 'red'}`}>
                    {w.active ? t('integrations.hooks.active') : w.disabledReason === 'failures' ? t('integrations.hooks.offFailures') : t('integrations.hooks.off')}
                  </span>
                  {w.failureCount > 0 && <div>{t('integrations.hooks.failures', { n: w.failureCount })}</div>}
                  {w.pending > 0 && <div>{t('integrations.hooks.pending', { n: w.pending })}</div>}
                  <div className="row">
                    <button type="button" className="link" disabled={busy} onClick={() => toggle(w)}>{w.active ? t('integrations.hooks.switchOff') : t('integrations.hooks.switchOn')}</button>
                    {w.active && <button type="button" className="link" disabled={busy} onClick={() => test(w)}>{t('integrations.hooks.test')}</button>}
                    <button type="button" className="link" disabled={busy} onClick={() => rotate(w)}>{t('integrations.hooks.rotate')}</button>
                    <button type="button" className="link" disabled={busy} onClick={() => remove(w)}>{t('integrations.hooks.delete')}</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
    </section>
  );
}

function Deliveries({ id, labels }: { id: string; labels: Record<string, string> }) {
  const STATUS = labelMap('integrations.hooks.status', ['pending', 'delivered', 'failed'] as const);
  const { data, error, loading } = useLoad<Delivery[]>(`/api/admin/webhooks/${id}/deliveries`);
  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  if (!data?.length) return <p className="small muted">{t('integrations.hooks.noDeliveries')}</p>;
  return (
    <div className="table-wrap" tabIndex={0}><table>
      <thead><tr><th>{t('integrations.hooks.colTime')}</th><th>{t('integrations.hooks.colEvent')}</th><th>{t('integrations.hooks.colResult')}</th><th>{t('integrations.hooks.colAttempts')}</th></tr></thead>
      <tbody>
        {data.map((d) => (
          <tr key={d.id}>
            <td className="small">{formatDateTime(d.createdAt)}</td>
            <td className="small">{labels[d.event] ?? d.event}</td>
            <td className="small">
              <span className={`badge ${d.status === 'delivered' ? 'green' : d.status === 'failed' ? 'red' : 'yellow'}`}>{STATUS[d.status]}</span>{' '}
              {d.responseStatus ?? ''} {d.error ? <code>{d.error}</code> : null}
              {d.status === 'pending' && d.attempts > 0 && <div>{t('integrations.hooks.nextAttempt', { time: formatDateTime(d.nextAttemptAt) })}</div>}
            </td>
            <td className="small">{d.attempts}</td>
          </tr>
        ))}
      </tbody>
    </table></div>
  );
}
