import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from '../api';
import { ErrorBox, Field, Loading, useAction, useLoad } from '../components';
import { formatDateTime, formatEuro, formatNumber, labelMap, t } from '../i18n';
import { COMPONENT_LABELS, STATE_LABELS } from './Status';
import { OperatorBilling } from './OperatorBilling';
import { ChangePassword, OperatorsAdmin, TenantsAdmin } from './OperatorAdmin';

// Operator and support console (R3-01, R3-07, R3-10). Own sign-in with a personal operator
// account (e-mail, password, TOTP code) and a role; OPERATOR_TOKEN only as bootstrap and
// break-glass path. Separate from the accounts of the workspaces. Customer data only with the
// workspace's grant, every access is logged in its audit log.

interface TenantStatus {
  id: string;
  slug: string;
  name: string;
  createdAt: string;
  users: number;
  lastLoginAt: string | null;
  ideas: number;
  ideas30d: number;
  aiQueued: number;
  aiRunning: number;
  aiOldestQueuedAgeSeconds: number | null;
  aiFailed24h: number;
  aiErrors24h: number;
  aiCostMonthEur: number;
  outboxPending: number;
  webhookFailed24h: number;
  supportUntil: string | null;
  keyState: 'current' | 'previous' | 'unknown' | 'missing';
  status: 'active' | 'suspended' | 'deleting';
}

const TENANT_STATUS = labelMap('ent.tenant.status', ['active', 'suspended', 'deleting'] as const);

interface Overview {
  platform: {
    status: 'ok' | 'degraded';
    alerts: { key: string; message: string }[];
    components: Record<string, 'operational' | 'degraded' | 'outage'>;
    metrics: { jobs: { lastRunAgeSeconds: number | null }; aiQueue: { queued: number; running: number }; outbox: { pending: number } };
    secretKey: boolean;
    rotationPending: boolean;
  };
  tenants: TenantStatus[];
}

interface SupportView {
  tenant: { id: string; name: string; slug: string; settingsVersion: number };
  grant: { expiresAt: string; reason: string };
  users: { displayName: string; email: string; roles: string[]; active: boolean; mfaEnabled: boolean; locked: boolean }[];
  ideas: { number: number; title: string | null; confidential: boolean; status: string; createdAt: string }[];
  aiFailures: { kind: string; error: string | null; finishedAt: string | null }[];
  webhooks: { name: string; active: boolean; failureCount: number; disabledReason: string | null }[];
  audit: { createdAt: string; action: string; entity: string; actorName: string | null }[];
}

interface Incident {
  id: string;
  kind: 'incident' | 'maintenance';
  severity: 'minor' | 'major';
  title: string;
  body: string;
  components: string[];
  startsAt: string;
  endsAt: string | null;
  resolvedAt: string | null;
}

const TABS = ['overview', 'tenants', 'create', 'incidents', 'billing', 'operators', 'log'] as const;
type Tab = (typeof TABS)[number];
/** Permission of the operator role that each tab needs (server: OPERATOR_PERMISSIONS). */
const TAB_PERMISSION: Record<Tab, string> = {
  overview: 'overview', tenants: 'tenants', create: 'tenants', incidents: 'support', billing: 'billing', operators: 'operators', log: 'overview',
};

export interface OperatorMe {
  operator: string;
  id: string | null;
  email: string | null;
  role: 'owner' | 'support' | 'billing' | 'technical';
  bootstrap: boolean;
  mustChangePassword: boolean;
  permissions: string[];
}

export function Operator() {
  const [state, setState] = useState<'loading' | 'off' | 'login' | 'password' | 'ready'>('loading');
  const [bootstrap, setBootstrap] = useState(false);
  const [me, setMe] = useState<OperatorMe | null>(null);
  const check = useCallback(async () => {
    try {
      const cfg = await api.get<{ enabled: boolean; bootstrap?: boolean }>('/api/operator/config');
      if (!cfg.enabled) return setState('off');
      setBootstrap(!!cfg.bootstrap);
      const who = await api.get<OperatorMe>('/api/operator/me');
      setMe(who);
      setState(who.mustChangePassword ? 'password' : 'ready');
    } catch {
      setState('login');
    }
  }, []);
  useEffect(() => void check(), [check]);

  return (
    <main id="inhalt" className="stack operator-page">
      <h1>{t('saas.op.title')}</h1>
      {state === 'loading' && <Loading />}
      {state === 'off' && <p>{t('saas.op.off')}</p>}
      {state === 'login' && <OperatorLogin bootstrap={bootstrap} onDone={check} />}
      {state === 'password' && <ChangePassword required onDone={check} />}
      {state === 'ready' && me && <Console me={me} onLogout={check} />}
    </main>
  );
}

function OperatorLogin({ bootstrap, onDone }: { bootstrap: boolean; onDone: () => Promise<void> }) {
  const [useToken, setUseToken] = useState(false);
  const [form, setForm] = useState({ email: '', password: '', token: '', code: '' });
  const { busy, error, run } = useAction();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const body = useToken ? { token: form.token, code: form.code } : { email: form.email, password: form.password, code: form.code };
    if (await run(() => api.post('/api/operator/login', body))) await onDone();
  };
  return (
    <form className="card login-wrap" onSubmit={submit}>
      <p className="muted">{useToken ? t('saas.op.loginIntro') : t('ent.op.loginIntro')}</p>
      <ErrorBox error={error} />
      {useToken ? (
        <Field id="op-token" label={t('saas.op.token')}>
          <input id="op-token" type="password" autoComplete="off" value={form.token} onChange={(e) => setForm({ ...form, token: e.target.value })} required />
        </Field>
      ) : (
        <>
          <Field id="op-email" label={t('ent.op.email')}>
            <input id="op-email" type="email" autoComplete="username" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
          </Field>
          <Field id="op-password" label={t('ent.op.password')}>
            <input id="op-password" type="password" autoComplete="current-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required />
          </Field>
        </>
      )}
      <Field id="op-code" label={t('saas.op.code')}>
        <input id="op-code" inputMode="numeric" autoComplete="one-time-code" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} required />
      </Field>
      <button className="primary" disabled={busy}>{t('saas.op.login')}</button>
      {bootstrap && (
        <button type="button" className="link" onClick={() => setUseToken(!useToken)}>{useToken ? t('ent.op.useAccount') : t('ent.op.useToken')}</button>
      )}
    </form>
  );
}

function Console({ me, onLogout }: { me: OperatorMe; onLogout: () => Promise<void> }) {
  const visible = TABS.filter((k) => me.permissions.includes(TAB_PERMISSION[k]));
  const [tab, setTab] = useState<Tab>(visible[0] ?? 'overview');
  const tabs = labelMap('saas.op.tab', TABS);
  const roles = labelMap('ent.op.role', ['owner', 'support', 'billing', 'technical'] as const);
  const logout = async () => {
    await api.post('/api/operator/logout');
    await onLogout();
  };
  return (
    <>
      <div className="row spread">
        <div className="tabs" role="tablist">
          {visible.map((k) => (
            <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>{tabs[k]}</button>
          ))}
        </div>
        <span className="row">
          <span className="small muted">{t('ent.op.signedIn', { name: me.operator, role: roles[me.role] })}</span>
          <button type="button" onClick={logout}>{t('saas.op.logout')}</button>
        </span>
      </div>
      {me.bootstrap && <div className="alert warn">{t('ent.op.bootstrapNote')}</div>}
      {tab === 'overview' && <OverviewTab canSupport={me.permissions.includes('support')} />}
      {tab === 'tenants' && <TenantsAdmin />}
      {tab === 'create' && <CreateTenant />}
      {tab === 'incidents' && <Incidents />}
      {tab === 'billing' && <OperatorBilling />}
      {tab === 'operators' && <OperatorsAdmin me={me} />}
      {tab === 'log' && <LogTab />}
      {!me.bootstrap && (
        <details className="card">
          <summary>{t('ent.op.ownPassword')}</summary>
          <ChangePassword onDone={async () => undefined} />
        </details>
      )}
    </>
  );
}

const KEY_TONE: Record<TenantStatus['keyState'], string> = { current: 'green', previous: 'yellow', unknown: 'red', missing: 'red' };

function OverviewTab({ canSupport }: { canSupport: boolean }) {
  const { data, error, loading, reload } = useLoad<Overview>('/api/operator/overview');
  const [support, setSupport] = useState<SupportView | null>(null);
  const { error: supportError, run } = useAction();
  const components = COMPONENT_LABELS();
  const states = STATE_LABELS();
  const keyStates = labelMap('saas.op.key', ['current', 'previous', 'unknown', 'missing'] as const);
  if (loading && !data) return <Loading />;
  if (!data) return <ErrorBox error={error} />;
  const open = async (id: string) => {
    const r = await run(() => api.get<SupportView>(`/api/operator/tenants/${id}/support`));
    if (r) setSupport(r);
  };
  return (
    <div className="stack">
      <section className="card stack" aria-labelledby="op-platform">
        <div className="row spread">
          <h2 id="op-platform">{t('saas.op.platform')}</h2>
          <button type="button" onClick={() => void reload()}>{t('saas.op.reload')}</button>
        </div>
        <p>
          {Object.entries(data.platform.components).map(([id, s]) => (
            <span key={id} className={`badge ${s === 'operational' ? 'green' : s === 'degraded' ? 'yellow' : 'red'}`}>{components[id] ?? id}: {states[s]}</span>
          ))}
        </p>
        {data.platform.alerts.length > 0 && (
          <ul>{data.platform.alerts.map((a) => <li key={a.key}>{a.message}</li>)}</ul>
        )}
        <p className="small muted">
          {t('saas.op.metrics', {
            jobs: data.platform.metrics.jobs.lastRunAgeSeconds == null ? '–' : Math.round(data.platform.metrics.jobs.lastRunAgeSeconds / 60),
            queued: data.platform.metrics.aiQueue.queued,
            running: data.platform.metrics.aiQueue.running,
            outbox: data.platform.metrics.outbox.pending,
          })}
        </p>
        {!data.platform.secretKey && <div className="alert error">{t('saas.op.noSecretKey')}</div>}
        {data.platform.rotationPending && <div className="alert warn">{t('saas.op.rotationPending')}</div>}
      </section>

      <section className="card" aria-labelledby="op-tenants">
        <h2 id="op-tenants">{t('saas.op.tenants', { n: data.tenants.length })}</h2>
        <ErrorBox error={supportError} />
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">{t('saas.op.col.tenant')}</th>
                <th scope="col">{t('saas.op.col.usage')}</th>
                <th scope="col">{t('saas.op.col.ai')}</th>
                <th scope="col">{t('saas.op.col.errors')}</th>
                <th scope="col">{t('saas.op.col.key')}</th>
                <th scope="col">{t('saas.op.col.support')}</th>
              </tr>
            </thead>
            <tbody>
              {data.tenants.map((x) => (
                <tr key={x.id}>
                  <td>
                    <strong>{x.name}</strong>
                    <div className="small muted">{x.slug} · {t('saas.op.created', { date: formatDateTime(x.createdAt) })}</div>
                  </td>
                  <td className="small">
                    {t('saas.op.usage', { users: x.users, ideas: x.ideas, recent: x.ideas30d })}
                    <div className="muted">{t('saas.op.lastLogin', { time: x.lastLoginAt ? formatDateTime(x.lastLoginAt) : '–' })}</div>
                  </td>
                  <td className="small">
                    {t('saas.op.aiQueue', { queued: x.aiQueued, running: x.aiRunning })}
                    <div className="muted">{t('saas.op.aiCost', { cost: formatEuro(x.aiCostMonthEur, 2) })}</div>
                  </td>
                  <td className="small">
                    {t('saas.op.errors', { ai: x.aiFailed24h + x.aiErrors24h, hooks: x.webhookFailed24h, mail: formatNumber(x.outboxPending) })}
                  </td>
                  <td><span className={`badge ${KEY_TONE[x.keyState]}`}>{keyStates[x.keyState]}</span></td>
                  <td>
                    {x.status !== 'active' && <div><span className={`badge ${x.status === 'suspended' ? 'red' : 'yellow'}`}>{TENANT_STATUS[x.status]}</span></div>}
                    {x.supportUntil && canSupport ? (
                      <button type="button" onClick={() => void open(x.id)}>{t('saas.op.openSupport', { time: formatDateTime(x.supportUntil) })}</button>
                    ) : (
                      <span className="small muted">{t('saas.op.noGrant')}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {support && <SupportPanel view={support} onClose={() => setSupport(null)} />}
    </div>
  );
}

function SupportPanel({ view, onClose }: { view: SupportView; onClose: () => void }) {
  return (
    <section className="card stack" aria-labelledby="op-support">
      <div className="row spread">
        <h2 id="op-support">{t('saas.op.supportTitle', { name: view.tenant.name })}</h2>
        <button type="button" onClick={onClose}>{t('saas.op.close')}</button>
      </div>
      <div className="alert info">{t('saas.op.supportNote', { time: formatDateTime(view.grant.expiresAt), reason: view.grant.reason })}</div>
      <h3>{t('saas.op.supportUsers')}</h3>
      <ul className="small">
        {view.users.map((u) => (
          <li key={u.email}>{u.displayName} · {u.email} · {u.roles.join(', ')}{!u.active && ` · ${t('saas.op.inactive')}`}{u.locked && ` · ${t('saas.op.locked')}`}</li>
        ))}
      </ul>
      <h3>{t('saas.op.supportIdeas')}</h3>
      <ul className="small">
        {view.ideas.map((i) => (
          <li key={i.number}>#{i.number} · {i.title ?? t('saas.op.confidential')} · {i.status} · {formatDateTime(i.createdAt)}</li>
        ))}
      </ul>
      <h3>{t('saas.op.supportAi')}</h3>
      {view.aiFailures.length ? (
        <ul className="small">{view.aiFailures.map((f, i) => <li key={i}>{f.kind} · {f.finishedAt ? formatDateTime(f.finishedAt) : '–'} · {f.error ?? '–'}</li>)}</ul>
      ) : <p className="small muted">{t('saas.op.none')}</p>}
      <h3>{t('saas.op.supportHooks')}</h3>
      {view.webhooks.length ? (
        <ul className="small">{view.webhooks.map((w) => <li key={w.name}>{w.name} · {w.active ? t('saas.op.active') : t('saas.op.inactive')} · {w.failureCount}</li>)}</ul>
      ) : <p className="small muted">{t('saas.op.none')}</p>}
      <h3>{t('saas.op.supportAudit')}</h3>
      <ul className="small">
        {view.audit.map((a, i) => <li key={i}>{formatDateTime(a.createdAt)} · {a.action} · {a.actorName ?? t('saas.op.system')}</li>)}
      </ul>
    </section>
  );
}

function CreateTenant() {
  const [form, setForm] = useState({ name: '', slug: '', adminName: '', adminEmail: '', locale: 'de' });
  const [done, setDone] = useState<{ slug: string; inviteLink?: string } | null>(null);
  const { busy, error, run } = useAction();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const r = await run(() => api.post<{ slug: string; inviteLink?: string }>('/api/operator/tenants', { ...form, slug: form.slug || undefined }));
    if (r) {
      setDone(r);
      setForm({ name: '', slug: '', adminName: '', adminEmail: '', locale: 'de' });
    }
  };
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  return (
    <form className="card" onSubmit={submit}>
      <h2>{t('saas.op.createTitle')}</h2>
      <p className="muted">{t('saas.op.createIntro')}</p>
      <ErrorBox error={error} />
      {done && (
        <div className="alert success" role="status">
          {t('saas.op.created.ok', { slug: done.slug })}
          {done.inviteLink && <div className="small">{t('saas.op.created.link')} <code>{done.inviteLink}</code></div>}
        </div>
      )}
      <div className="grid grid-2">
        <Field id="ct-name" label={t('saas.op.f.name')}><input id="ct-name" value={form.name} onChange={set('name')} required minLength={2} maxLength={80} /></Field>
        <Field id="ct-slug" label={t('saas.op.f.slug')} hint={t('saas.op.f.slugHint')}><input id="ct-slug" value={form.slug} onChange={set('slug')} pattern="[a-z0-9-]{2,40}" /></Field>
        <Field id="ct-admin" label={t('saas.op.f.adminName')}><input id="ct-admin" value={form.adminName} onChange={set('adminName')} required minLength={2} /></Field>
        <Field id="ct-email" label={t('saas.op.f.adminEmail')}><input id="ct-email" type="email" value={form.adminEmail} onChange={set('adminEmail')} required /></Field>
        <Field id="ct-locale" label={t('saas.op.f.locale')}>
          <select id="ct-locale" value={form.locale} onChange={set('locale')}>
            <option value="de">{t('saas.op.f.de')}</option>
            <option value="en">{t('saas.op.f.en')}</option>
          </select>
        </Field>
      </div>
      <button className="primary" disabled={busy}>{t('saas.op.create')}</button>
    </form>
  );
}

function Incidents() {
  const { data, error, loading, reload } = useLoad<Incident[]>('/api/operator/incidents');
  const empty = { kind: 'incident' as Incident['kind'], severity: 'minor' as Incident['severity'], title: '', body: '', components: [] as string[], startsAt: '', endsAt: '' };
  const [form, setForm] = useState(empty);
  const { busy, error: saveError, run } = useAction();
  const components = COMPONENT_LABELS();
  const iso = (local: string) => (local ? new Date(local).toISOString() : undefined);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const r = await run(() => api.post('/api/operator/incidents', { ...form, startsAt: iso(form.startsAt), endsAt: iso(form.endsAt) ?? null }));
    if (r) {
      setForm(empty);
      await reload();
    }
  };
  const resolve = async (id: string) => {
    if (await run(() => api.patch(`/api/operator/incidents/${id}`, { resolved: true }))) await reload();
  };
  const remove = async (id: string) => {
    if (!window.confirm(t('saas.op.inc.confirmDelete'))) return;
    if (await run(() => api.del(`/api/operator/incidents/${id}`))) await reload();
  };
  return (
    <div className="stack">
      <form className="card" onSubmit={submit}>
        <h2>{t('saas.op.inc.new')}</h2>
        <p className="muted small">{t('saas.op.inc.intro')}</p>
        <ErrorBox error={saveError} />
        <div className="grid grid-2">
          <Field id="inc-kind" label={t('saas.op.inc.kind')}>
            <select id="inc-kind" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as Incident['kind'] })}>
              <option value="incident">{t('saas.notice.incident')}</option>
              <option value="maintenance">{t('saas.notice.maintenance')}</option>
            </select>
          </Field>
          <Field id="inc-sev" label={t('saas.op.inc.severity')}>
            <select id="inc-sev" value={form.severity} onChange={(e) => setForm({ ...form, severity: e.target.value as Incident['severity'] })}>
              <option value="minor">{t('saas.notice.minor')}</option>
              <option value="major">{t('saas.notice.major')}</option>
            </select>
          </Field>
          <Field id="inc-title" label={t('saas.op.inc.title')}><input id="inc-title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} required minLength={3} maxLength={200} /></Field>
          <Field id="inc-start" label={t('saas.op.inc.start')} hint={t('saas.op.inc.startHint')}><input id="inc-start" type="datetime-local" value={form.startsAt} onChange={(e) => setForm({ ...form, startsAt: e.target.value })} /></Field>
          <Field id="inc-end" label={t('saas.op.inc.end')}><input id="inc-end" type="datetime-local" value={form.endsAt} onChange={(e) => setForm({ ...form, endsAt: e.target.value })} /></Field>
        </div>
        <Field id="inc-body" label={t('saas.op.inc.body')} hint={t('saas.op.inc.bodyHint')}>
          <textarea id="inc-body" rows={3} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} maxLength={4000} />
        </Field>
        <fieldset className="row">
          <legend>{t('saas.op.inc.components')}</legend>
          {Object.entries(components).map(([id, label]) => (
            <label key={id} className="check">
              <input type="checkbox" checked={form.components.includes(id)} onChange={(e) => setForm({ ...form, components: e.target.checked ? [...form.components, id] : form.components.filter((c) => c !== id) })} />
              {label}
            </label>
          ))}
        </fieldset>
        <button className="primary" disabled={busy}>{t('saas.op.inc.save')}</button>
      </form>
      <section className="card" aria-labelledby="inc-list">
        <h2 id="inc-list">{t('saas.op.inc.list')}</h2>
        {loading && !data && <Loading />}
        <ErrorBox error={error} />
        {data && !data.length && <p className="muted">{t('saas.op.none')}</p>}
        <ul className="idea-list">
          {data?.map((i) => (
            <li key={i.id} className="row spread">
              <span>
                <strong>{i.title}</strong> · {i.kind === 'maintenance' ? t('saas.notice.maintenance') : t('saas.notice.incident')}
                <span className="small muted"> · {formatDateTime(i.startsAt)}{i.resolvedAt ? ` · ${t('saas.op.inc.resolvedAt', { time: formatDateTime(i.resolvedAt) })}` : ''}</span>
              </span>
              <span className="row">
                {!i.resolvedAt && <button type="button" onClick={() => void resolve(i.id)}>{t('saas.op.inc.resolve')}</button>}
                <button type="button" onClick={() => void remove(i.id)}>{t('saas.op.inc.delete')}</button>
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function LogTab() {
  const { data, error, loading } = useLoad<{ id: number; operator: string; operatorEmail: string | null; action: string; tenantName: string | null; createdAt: string }[]>('/api/operator/log');
  if (loading && !data) return <Loading />;
  if (!data) return <ErrorBox error={error} />;
  return (
    <section className="card">
      <h2>{t('saas.op.logTitle')}</h2>
      <ul className="small">
        {data.map((l) => <li key={l.id}>{formatDateTime(l.createdAt)} · {l.operator}{l.operatorEmail ? ` (${l.operatorEmail})` : ''} · {l.action}{l.tenantName ? ` · ${l.tenantName}` : ''}</li>)}
      </ul>
    </section>
  );
}

