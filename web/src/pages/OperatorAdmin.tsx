import { useState, type FormEvent } from 'react';
import { ApiError, api } from '../api';
import { ErrorBox, Field, Loading, useAction, useLoad } from '../components';
import { formatDateTime, labelMap, t } from '../i18n';
import { FEATURES } from '../plan';
import type { OperatorMe } from './Operator';

// Operator console, enterprise parts: tenant status (suspend, resume, offboarding), feature
// switches and limits per tenant, proof of deletions, operator accounts and the own password.

interface TenantRow {
  id: string;
  slug: string;
  name: string;
  status: 'active' | 'suspended' | 'deleting';
  suspendedAt: string | null;
  suspendedReason: string | null;
  deletionRequestedAt: string | null;
  deleteAfter: string | null;
}

interface Override {
  key: string;
  kind: 'feature' | 'limit';
  enabled: boolean | null;
  value: number | null;
  reason: string;
  expiresAt: string | null;
  expired: boolean;
  setBy: string;
  setAt: string;
}

interface Deletion {
  id: string;
  slug: string;
  requestedByKind: string;
  requestedBy: string;
  reason: string | null;
  requestedAt: string;
  purgedAt: string;
  rowCounts: Record<string, number>;
}

const STATUS = labelMap('ent.tenant.status', ['active', 'suspended', 'deleting'] as const);
const LIMITS = ['fullAnalysesPerMonth', 'maxChallenges'] as const;
const LIMIT_LABELS = labelMap('ent.limit', LIMITS);
const FEATURE_LABELS = labelMap('billing.feature', FEATURES);
const ROLES = ['owner', 'support', 'billing', 'technical'] as const;
const ROLE_LABELS = labelMap('ent.op.role', ROLES);

type Action = 'suspend' | 'resume' | 'offboarding' | 'cancel';

export function TenantsAdmin() {
  const { data, error, loading, reload } = useLoad<{ tenants: TenantRow[] }>('/api/operator/overview');
  const deletions = useLoad<Deletion[]>('/api/operator/deletions');
  const [pending, setPending] = useState<{ tenant: TenantRow; action: Action } | null>(null);
  const [overridesFor, setOverridesFor] = useState<TenantRow | null>(null);
  if (loading && !data) return <Loading />;
  if (!data) return <ErrorBox error={error} />;
  return (
    <div className="stack">
      <section className="card" aria-labelledby="h-op-tenants">
        <h2 id="h-op-tenants">{t('ent.tenants.title')}</h2>
        <p className="small muted">{t('ent.tenants.intro')}</p>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">{t('saas.op.col.tenant')}</th>
                <th scope="col">{t('ent.tenants.col.status')}</th>
                <th scope="col">{t('ent.tenants.col.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {data.tenants.map((x) => (
                <tr key={x.id}>
                  <td>
                    <strong>{x.name}</strong>
                    <div className="small muted">{x.slug}</div>
                  </td>
                  <td className="small">
                    <span className={`badge ${x.status === 'active' ? 'green' : x.status === 'suspended' ? 'red' : 'yellow'}`}>{STATUS[x.status]}</span>
                    {x.status === 'suspended' && x.suspendedReason && (
                      <div>{t('ent.tenants.suspendedSince', { time: x.suspendedAt ? formatDateTime(x.suspendedAt) : '–', reason: x.suspendedReason })}</div>
                    )}
                    {x.status === 'deleting' && x.deleteAfter && <div>{t('ent.tenants.deleteAfter', { time: formatDateTime(x.deleteAfter) })}</div>}
                  </td>
                  <td className="row">
                    {x.status === 'active' && (
                      <button type="button" onClick={() => setPending({ tenant: x, action: 'suspend' })}>
                        {t('ent.tenants.suspend')}
                      </button>
                    )}
                    {x.status === 'suspended' && (
                      <button type="button" onClick={() => setPending({ tenant: x, action: 'resume' })}>
                        {t('ent.tenants.resume')}
                      </button>
                    )}
                    {x.status !== 'deleting' && (
                      <button type="button" className="danger" onClick={() => setPending({ tenant: x, action: 'offboarding' })}>
                        {t('ent.tenants.offboard')}
                      </button>
                    )}
                    {x.status === 'deleting' && (
                      <button type="button" onClick={() => setPending({ tenant: x, action: 'cancel' })}>
                        {t('ent.tenants.cancelDelete')}
                      </button>
                    )}
                    <button type="button" onClick={() => setOverridesFor(x)}>
                      {t('ent.tenants.overrides')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      {pending && (
        <StatusForm
          key={`${pending.tenant.id}-${pending.action}`}
          tenant={pending.tenant}
          action={pending.action}
          onClose={() => setPending(null)}
          onDone={async () => {
            setPending(null);
            await reload();
          }}
        />
      )}
      {overridesFor && <Overrides key={overridesFor.id} tenant={overridesFor} onClose={() => setOverridesFor(null)} />}
      <section className="card" aria-labelledby="h-op-deletions">
        <h2 id="h-op-deletions">{t('ent.deletions.title')}</h2>
        <p className="small muted">{t('ent.deletions.intro')}</p>
        {deletions.data && !deletions.data.length && <p className="muted">{t('saas.op.none')}</p>}
        <ul className="small">
          {deletions.data?.map((d) => (
            <li key={d.id}>
              {t('ent.deletions.line', {
                slug: d.slug,
                time: formatDateTime(d.purgedAt),
                requested: formatDateTime(d.requestedAt),
                by: `${d.requestedByKind}: ${d.requestedBy}`,
                rows: Object.values(d.rowCounts).reduce((a, b) => a + b, 0),
              })}
              {d.reason ? ` · ${d.reason}` : ''}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function StatusForm({ tenant, action, onClose, onDone }: { tenant: TenantRow; action: Action; onClose: () => void; onDone: () => Promise<void> }) {
  const [reason, setReason] = useState('');
  const [graceDays, setGraceDays] = useState(30);
  const { busy, error, run } = useAction();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const url = {
      suspend: `/api/operator/tenants/${tenant.id}/suspend`,
      resume: `/api/operator/tenants/${tenant.id}/resume`,
      offboarding: `/api/operator/tenants/${tenant.id}/offboarding`,
      cancel: `/api/operator/tenants/${tenant.id}/offboarding/cancel`,
    }[action];
    const body = action === 'cancel' ? undefined : action === 'offboarding' ? { reason, graceDays } : { reason };
    if (await run(() => api.post(url, body))) await onDone();
  };
  return (
    <form className="card stack" onSubmit={submit} aria-labelledby="h-status-form">
      <h2 id="h-status-form">
        {
          {
            suspend: t('ent.tenants.form.suspend', { name: tenant.name }),
            resume: t('ent.tenants.form.resume', { name: tenant.name }),
            offboarding: t('ent.tenants.form.offboarding', { name: tenant.name }),
            cancel: t('ent.tenants.form.cancel', { name: tenant.name }),
          }[action]
        }
      </h2>
      <ErrorBox error={error} />
      {action !== 'cancel' && (
        <Field id="st-reason" label={t('ent.tenants.reason')} hint={t('ent.tenants.reasonHint')}>
          <input id="st-reason" value={reason} onChange={(e) => setReason(e.target.value)} required minLength={3} maxLength={300} />
        </Field>
      )}
      {action === 'offboarding' && (
        <Field id="st-grace" label={t('ent.tenants.graceDays')} hint={t('ent.tenants.graceHint')}>
          <input id="st-grace" type="number" min={0} max={365} value={graceDays} onChange={(e) => setGraceDays(Number(e.target.value))} />
        </Field>
      )}
      <div className="row">
        <button type="button" onClick={onClose}>
          {t('common.cancel')}
        </button>
        <button className={action === 'offboarding' || action === 'suspend' ? 'danger' : 'primary'} disabled={busy}>
          {t('ent.tenants.submit')}
        </button>
      </div>
    </form>
  );
}

function Overrides({ tenant, onClose }: { tenant: TenantRow; onClose: () => void }) {
  const { data, error, reload } = useLoad<Override[]>(`/api/operator/tenants/${tenant.id}/overrides`);
  const empty = { kind: 'feature' as 'feature' | 'limit', key: 'api', enabled: true, value: 0, reason: '', expiresAt: '' };
  const [form, setForm] = useState(empty);
  const { busy, error: saveError, run } = useAction();
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const body =
      form.kind === 'feature'
        ? {
            kind: 'feature',
            key: form.key,
            enabled: form.enabled,
            reason: form.reason,
            expiresAt: form.expiresAt ? new Date(form.expiresAt).toISOString() : null,
          }
        : { kind: 'limit', key: form.key, value: form.value, reason: form.reason, expiresAt: form.expiresAt ? new Date(form.expiresAt).toISOString() : null };
    if (await run(() => api.put(`/api/operator/tenants/${tenant.id}/overrides`, body))) {
      setForm(empty);
      await reload();
    }
  };
  const remove = async (key: string) => {
    const reason = window.prompt(t('ent.overrides.removeReason'));
    if (!reason) return;
    if (
      await run(() =>
        fetch(`/api/operator/tenants/${tenant.id}/overrides/${key}`, {
          method: 'DELETE',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ reason }),
        }).then(async (r) => {
          if (!r.ok) throw new Error((await r.json()).error);
        }),
      )
    )
      await reload();
  };
  const keyLabel = (o: { kind: string; key: string }) => (o.kind === 'feature' ? FEATURE_LABELS[o.key] : LIMIT_LABELS[o.key]) ?? o.key;
  return (
    <section className="card stack" aria-labelledby="h-overrides">
      <div className="row spread">
        <h2 id="h-overrides">{t('ent.overrides.title', { name: tenant.name })}</h2>
        <button type="button" onClick={onClose}>
          {t('saas.op.close')}
        </button>
      </div>
      <p className="small muted">{t('ent.overrides.intro')}</p>
      <ErrorBox error={error ?? saveError} />
      {data && !data.length && <p className="muted">{t('saas.op.none')}</p>}
      <ul className="small">
        {data?.map((o) => (
          <li key={o.key} className="row spread">
            <span>
              <strong>{keyLabel(o)}</strong>: {o.kind === 'feature' ? (o.enabled ? t('ent.overrides.on') : t('ent.overrides.off')) : o.value}
              {' · '}
              {o.reason} · {o.setBy}
              {o.expiresAt && ` · ${o.expired ? t('ent.overrides.expired') : t('ent.overrides.until', { time: formatDateTime(o.expiresAt) })}`}
            </span>
            <button type="button" className="link" onClick={() => void remove(o.key)}>
              {t('ent.overrides.remove')}
            </button>
          </li>
        ))}
      </ul>
      <form onSubmit={save} className="stack">
        <div className="grid grid-3">
          <Field id="ov-kind" label={t('ent.overrides.kind')}>
            <select
              id="ov-kind"
              value={form.kind}
              onChange={(e) => {
                const kind = e.target.value as 'feature' | 'limit';
                setForm({ ...form, kind, key: kind === 'feature' ? 'api' : 'fullAnalysesPerMonth' });
              }}
            >
              <option value="feature">{t('ent.overrides.kindFeature')}</option>
              <option value="limit">{t('ent.overrides.kindLimit')}</option>
            </select>
          </Field>
          <Field id="ov-key" label={t('ent.overrides.key')}>
            <select id="ov-key" value={form.key} onChange={(e) => setForm({ ...form, key: e.target.value })}>
              {(form.kind === 'feature' ? FEATURES : LIMITS).map((k) => (
                <option key={k} value={k}>
                  {keyLabel({ kind: form.kind, key: k })}
                </option>
              ))}
            </select>
          </Field>
          {form.kind === 'feature' ? (
            <Field id="ov-enabled" label={t('ent.overrides.value')}>
              <select id="ov-enabled" value={form.enabled ? 'on' : 'off'} onChange={(e) => setForm({ ...form, enabled: e.target.value === 'on' })}>
                <option value="on">{t('ent.overrides.on')}</option>
                <option value="off">{t('ent.overrides.off')}</option>
              </select>
            </Field>
          ) : (
            <Field id="ov-value" label={t('ent.overrides.value')}>
              <input id="ov-value" type="number" min={0} value={form.value} onChange={(e) => setForm({ ...form, value: Number(e.target.value) })} />
            </Field>
          )}
          <Field id="ov-reason" label={t('ent.tenants.reason')}>
            <input id="ov-reason" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} required minLength={3} maxLength={300} />
          </Field>
          <Field id="ov-expires" label={t('ent.overrides.expires')} hint={t('ent.overrides.expiresHint')}>
            <input id="ov-expires" type="datetime-local" value={form.expiresAt} onChange={(e) => setForm({ ...form, expiresAt: e.target.value })} />
          </Field>
        </div>
        <div>
          <button className="primary" disabled={busy}>
            {t('ent.overrides.save')}
          </button>
        </div>
      </form>
    </section>
  );
}

interface OperatorAccount {
  id: string;
  email: string;
  name: string;
  role: (typeof ROLES)[number];
  active: boolean;
  mustChangePassword: boolean;
  locked: boolean;
  lastLoginAt: string | null;
}

interface Credentials {
  password: string;
  totpSecret: string;
  otpauthUrl: string;
}

export function OperatorsAdmin({ me }: { me: OperatorMe }) {
  const { data, error, reload } = useLoad<OperatorAccount[]>('/api/operator/operators');
  const [form, setForm] = useState({ email: '', name: '', role: 'support' as (typeof ROLES)[number] });
  const [shown, setShown] = useState<(Credentials & { email: string }) | null>(null);
  const { busy, error: actionError, run } = useAction();
  const create = async (e: FormEvent) => {
    e.preventDefault();
    const r = await run(() => api.post<Credentials>('/api/operator/operators', form));
    if (r) {
      setShown({ ...r, email: form.email });
      setForm({ email: '', name: '', role: 'support' });
      await reload();
    }
  };
  const patch = async (id: string, body: object) => {
    if (await run(() => api.patch(`/api/operator/operators/${id}`, body))) await reload();
  };
  const reset = async (o: OperatorAccount) => {
    if (!window.confirm(t('ent.operators.resetConfirm', { name: o.name }))) return;
    const r = await run(() => api.post<Credentials>(`/api/operator/operators/${o.id}/reset`));
    if (r) {
      setShown({ ...r, email: o.email });
      await reload();
    }
  };
  return (
    <div className="stack">
      <section className="card" aria-labelledby="h-operators">
        <h2 id="h-operators">{t('ent.operators.title')}</h2>
        <p className="small muted">{t('ent.operators.intro')}</p>
        <ErrorBox error={error ?? actionError} />
        {shown && (
          <div className="alert success" role="status">
            <p>{t('ent.operators.credentials', { email: shown.email })}</p>
            <p className="small">
              {t('ent.operators.password')} <code>{shown.password}</code>
            </p>
            <p className="small">
              {t('ent.operators.totp')} <code>{shown.totpSecret}</code>
            </p>
            <p className="small" style={{ wordBreak: 'break-all' }}>
              <code>{shown.otpauthUrl}</code>
            </p>
            <button type="button" onClick={() => setShown(null)}>
              {t('saas.op.close')}
            </button>
          </div>
        )}
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">{t('ent.operators.col.person')}</th>
                <th scope="col">{t('ent.operators.col.role')}</th>
                <th scope="col">{t('ent.operators.col.state')}</th>
                <th scope="col">{t('ent.tenants.col.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {data?.map((o) => (
                <tr key={o.id}>
                  <td>
                    <strong>{o.name}</strong>
                    <div className="small muted">{o.email}</div>
                  </td>
                  <td>
                    <label className="sr-only" htmlFor={`role-${o.id}`}>
                      {t('ent.operators.roleFor', { name: o.name })}
                    </label>
                    <select id={`role-${o.id}`} value={o.role} disabled={busy || o.id === me.id} onChange={(e) => void patch(o.id, { role: e.target.value })}>
                      {ROLES.map((r) => (
                        <option key={r} value={r}>
                          {ROLE_LABELS[r]}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="small">
                    <span className={`badge ${o.active ? 'green' : ''}`}>{o.active ? t('saas.op.active') : t('saas.op.inactive')}</span>
                    {o.locked && <span className="badge red">{t('saas.op.locked')}</span>}
                    {o.mustChangePassword && <span className="badge yellow">{t('ent.operators.mustChange')}</span>}
                    <div className="muted">{t('saas.op.lastLogin', { time: o.lastLoginAt ? formatDateTime(o.lastLoginAt) : '–' })}</div>
                  </td>
                  <td className="row">
                    {o.id !== me.id && (
                      <button type="button" onClick={() => void patch(o.id, { active: !o.active })}>
                        {o.active ? t('ent.operators.deactivate') : t('ent.operators.activate')}
                      </button>
                    )}
                    <button type="button" onClick={() => void reset(o)}>
                      {t('ent.operators.reset')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <form className="card" onSubmit={create}>
        <h2>{t('ent.operators.new')}</h2>
        <div className="grid grid-3">
          <Field id="opn-name" label={t('ent.operators.name')}>
            <input id="opn-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required minLength={2} />
          </Field>
          <Field id="opn-email" label={t('ent.op.email')}>
            <input id="opn-email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
          </Field>
          <Field id="opn-role" label={t('ent.operators.col.role')}>
            <select id="opn-role" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as (typeof ROLES)[number] })}>
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABELS[r]}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <p className="small muted">{t('ent.operators.roleHelp')}</p>
        <button className="primary" disabled={busy}>
          {t('ent.operators.create')}
        </button>
      </form>
    </div>
  );
}

export function ChangePassword({ required, onDone }: { required?: boolean; onDone: () => Promise<void> }) {
  const [form, setForm] = useState({ current: '', password: '', repeat: '' });
  const [ok, setOk] = useState(false);
  const { busy, error, run, setError } = useAction();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setOk(false);
    if (form.password !== form.repeat) {
      setError(new ApiError(400, t('ent.op.passwordMismatch')));
      return;
    }
    if (await run(() => api.post('/api/operator/me/password', { current: form.current, password: form.password }))) {
      setForm({ current: '', password: '', repeat: '' });
      setOk(true);
      await onDone();
    }
  };
  return (
    <form className={required ? 'card login-wrap' : 'stack'} onSubmit={submit}>
      {required && <p>{t('ent.op.passwordRequired')}</p>}
      <ErrorBox error={error} />
      {ok && (
        <div className="alert success" role="status">
          {t('ent.op.passwordChanged')}
        </div>
      )}
      <Field id="pw-current" label={t('ent.op.currentPassword')}>
        <input
          id="pw-current"
          type="password"
          autoComplete="current-password"
          value={form.current}
          onChange={(e) => setForm({ ...form, current: e.target.value })}
          required
        />
      </Field>
      <Field id="pw-new" label={t('ent.op.newPassword')} hint={t('ent.op.passwordHint')}>
        <input
          id="pw-new"
          type="password"
          autoComplete="new-password"
          minLength={12}
          value={form.password}
          onChange={(e) => setForm({ ...form, password: e.target.value })}
          required
        />
      </Field>
      <Field id="pw-repeat" label={t('ent.op.repeatPassword')}>
        <input
          id="pw-repeat"
          type="password"
          autoComplete="new-password"
          minLength={12}
          value={form.repeat}
          onChange={(e) => setForm({ ...form, repeat: e.target.value })}
          required
        />
      </Field>
      <div>
        <button className="primary" disabled={busy}>
          {t('ent.op.savePassword')}
        </button>
      </div>
    </form>
  );
}
