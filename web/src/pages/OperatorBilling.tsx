import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { ErrorBox, Field, Loading, useAction, useLoad } from '../components';
import { formatDate, formatEuro, formatNumber, labelMap, t } from '../i18n';
import { FEATURES, type Feature } from '../plan';

// Packages and billing in the operator console (AP-18): package per workspace with feature
// overrides, AI top-ups, invoice drafts and the conversion rates (R3-05, R3-06, R3-39).
// No payment provider: the drafts are checked and sent by the provider.

const PLAN_IDS = ['internal', 'trial', 'team', 'business_1000', 'business_2500', 'enterprise', 'challenge'] as const;
type PlanId = (typeof PLAN_IDS)[number];
const PLAN_LABELS = labelMap('billing.plan', PLAN_IDS);
const STATUS_LABELS = labelMap('billing.status', ['trial', 'active', 'read_only', 'ended'] as const);
const FEATURE_LABELS = labelMap('billing.feature', FEATURES);

interface TenantPlan {
  id: string;
  slug: string;
  name: string;
  plan: PlanId;
  status: 'trial' | 'active' | 'read_only' | 'ended';
  readOnly: boolean;
  employees: number | null;
  startsOn: string | null;
  trialEndsOn: string | null;
  endsOn: string | null;
  priceEur: number | null;
  features: Record<Feature, boolean>;
  featureOverrides: Partial<Record<Feature, boolean>>;
  quotaOverride: number | null;
  request: { plan: PlanId; employees: number | null; at: string } | null;
  usage: { limit: number | null; used: number; percent: number | null; topups: number };
}

interface Invoice {
  id: string;
  number: string;
  tenantName: string;
  periodStart: string;
  periodEnd: string;
  plan: PlanId;
  netEur: number;
  grossEur: number;
}

interface Kpi {
  started: number;
  converted: number;
  ended: number;
  rate: number | null;
}

export function OperatorBilling() {
  const tenants = useLoad<TenantPlan[]>('/api/operator/billing/tenants');
  const invoices = useLoad<Invoice[]>('/api/operator/billing/invoices');
  const kpis = useLoad<{ challenge: Kpi; trial: Kpi }>('/api/operator/billing/kpis');
  const [edit, setEdit] = useState<TenantPlan | null>(null);
  const reload = async () => {
    await Promise.all([tenants.reload(), invoices.reload(), kpis.reload()]);
  };
  if (tenants.loading && !tenants.data) return <Loading />;
  return (
    <div className="stack">
      {kpis.data && (
        <section className="card" aria-labelledby="ob-kpi">
          <h2 id="ob-kpi" style={{ marginTop: 0 }}>{t('billing.op.kpiHeading')}</h2>
          <p>{t('billing.op.kpiChallenge', { converted: kpis.data.challenge.converted, started: kpis.data.challenge.started, rate: kpis.data.challenge.rate == null ? '–' : formatNumber(kpis.data.challenge.rate, 1) })}</p>
          <p style={{ marginBottom: 0 }}>{t('billing.op.kpiTrial', { converted: kpis.data.trial.converted, started: kpis.data.trial.started, rate: kpis.data.trial.rate == null ? '–' : formatNumber(kpis.data.trial.rate, 1) })}</p>
        </section>
      )}
      <section className="card" aria-labelledby="ob-tenants">
        <h2 id="ob-tenants" style={{ marginTop: 0 }}>{t('billing.op.tenants')}</h2>
        <ErrorBox error={tenants.error} />
        <div className="table-wrap" tabIndex={0}>
          <table>
            <thead>
              <tr>
                <th scope="col">{t('billing.op.workspace')}</th>
                <th scope="col">{t('billing.current.plan')}</th>
                <th scope="col">{t('billing.op.quota')}</th>
                <th scope="col">{t('billing.op.request')}</th>
                <th scope="col"><span className="sr-only">{t('billing.op.edit')}</span></th>
              </tr>
            </thead>
            <tbody>
              {(tenants.data ?? []).map((x) => (
                <tr key={x.id}>
                  <th scope="row">{x.name}<div className="small muted">{x.slug}</div></th>
                  <td>
                    {PLAN_LABELS[x.plan]} <span className={`badge ${x.readOnly ? 'yellow' : 'green'}`}>{STATUS_LABELS[x.status]}</span>
                    <div className="small muted">
                      {x.employees != null && `${formatNumber(x.employees)} · `}
                      {x.priceEur != null && `${formatEuro(x.priceEur)} · `}
                      {x.trialEndsOn && t('billing.op.until', { date: formatDate(x.trialEndsOn) })}
                      {x.endsOn && t('billing.op.until', { date: formatDate(x.endsOn) })}
                    </div>
                  </td>
                  <td>{x.usage.limit == null ? formatNumber(x.usage.used) : `${x.usage.used} / ${x.usage.limit}`}</td>
                  <td>{x.request ? `${PLAN_LABELS[x.request.plan]}${x.request.employees ? ` (${formatNumber(x.request.employees)})` : ''}` : '–'}</td>
                  <td><button type="button" onClick={() => setEdit(x)}>{t('billing.op.edit')}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      {edit && <EditPlan key={edit.id} tenant={edit} onDone={async () => { setEdit(null); await reload(); }} onCancel={() => setEdit(null)} />}
      <InvoiceList invoices={invoices.data ?? []} onGenerated={reload} />
    </div>
  );
}

function EditPlan({ tenant, onDone, onCancel }: { tenant: TenantPlan; onDone: () => Promise<void>; onCancel: () => void }) {
  const [plan, setPlan] = useState<PlanId>(tenant.request?.plan ?? tenant.plan);
  const [employees, setEmployees] = useState(String(tenant.request?.employees ?? tenant.employees ?? ''));
  const [startsOn, setStartsOn] = useState('');
  const [overrides, setOverrides] = useState<Partial<Record<Feature, boolean>>>(tenant.featureOverrides);
  const [quota, setQuota] = useState(tenant.quotaOverride == null ? '' : String(tenant.quotaOverride));
  const [topup, setTopup] = useState({ analyses: '', priceEur: '' });
  const save = useAction();
  const book = useAction();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const ok = await save.run(() => api.put(`/api/operator/billing/tenants/${tenant.id}/plan`, {
      plan, employees: employees ? Number(employees) : null, startsOn: startsOn || undefined, featureOverrides: overrides, quotaOverride: quota === '' ? null : Number(quota),
    }));
    if (ok) await onDone();
  };
  const bookTopup = async () => {
    const ok = await book.run(() => api.post(`/api/operator/billing/tenants/${tenant.id}/topups`, { analyses: Number(topup.analyses), priceEur: Number(topup.priceEur) }));
    if (ok) await onDone();
  };
  const cycle = (f: Feature) => {
    const next = { ...overrides };
    if (next[f] === undefined) next[f] = !tenant.features[f];
    else delete next[f];
    setOverrides(next);
  };
  return (
    <form className="card stack" onSubmit={submit} aria-labelledby="ob-edit">
      <h2 id="ob-edit" style={{ marginTop: 0 }}>{t('billing.op.editTitle', { name: tenant.name })}</h2>
      <ErrorBox error={save.error} />
      <div className="grid grid-3">
        <Field id="ob-plan" label={t('billing.current.plan')}>
          <select id="ob-plan" value={plan} onChange={(e) => setPlan(e.target.value as PlanId)}>
            {PLAN_IDS.map((p) => <option key={p} value={p}>{PLAN_LABELS[p]}</option>)}
          </select>
        </Field>
        <Field id="ob-employees" label={t('billing.current.employees')}>
          <input id="ob-employees" type="number" min={1} value={employees} onChange={(e) => setEmployees(e.target.value)} />
        </Field>
        <Field id="ob-start" label={t('billing.op.startsOn')}>
          <input id="ob-start" type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} />
        </Field>
        <Field id="ob-quota" label={t('billing.op.quotaOverride')}>
          <input id="ob-quota" type="number" min={0} value={quota} onChange={(e) => setQuota(e.target.value)} />
        </Field>
      </div>
      <fieldset>
        <legend>{t('billing.op.overrides')}</legend>
        {FEATURES.map((f) => (
          <label key={f} className="check">
            <input type="checkbox" checked={overrides[f] ?? tenant.features[f]} onChange={() => cycle(f)} />
            {FEATURE_LABELS[f]}{overrides[f] !== undefined && <span className="badge accent">{t('billing.op.overridden')}</span>}
          </label>
        ))}
      </fieldset>
      <div className="row">
        <button type="submit" className="primary" disabled={save.busy}>{t('billing.op.save')}</button>
        <button type="button" onClick={onCancel}>{t('billing.process.discard')}</button>
      </div>
      <h3>{t('billing.op.topupTitle')}</h3>
      <ErrorBox error={book.error} />
      <div className="grid grid-3">
        <Field id="ob-topup-n" label={t('billing.op.topupAnalyses')}>
          <input id="ob-topup-n" type="number" min={1} value={topup.analyses} onChange={(e) => setTopup({ ...topup, analyses: e.target.value })} />
        </Field>
        <Field id="ob-topup-eur" label={t('billing.op.topupPrice')}>
          <input id="ob-topup-eur" type="number" min={0} step="0.01" value={topup.priceEur} onChange={(e) => setTopup({ ...topup, priceEur: e.target.value })} />
        </Field>
      </div>
      <div><button type="button" onClick={bookTopup} disabled={book.busy || !topup.analyses || topup.priceEur === ''}>{t('billing.op.topupBook')}</button></div>
    </form>
  );
}

function InvoiceList({ invoices, onGenerated }: { invoices: Invoice[]; onGenerated: () => Promise<void> }) {
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const gen = useAction();
  const generate = async () => {
    const ok = await gen.run(() => api.post('/api/operator/billing/invoices/generate', { month }));
    if (ok) await onGenerated();
  };
  return (
    <section className="card" aria-labelledby="ob-invoices">
      <h2 id="ob-invoices" style={{ marginTop: 0 }}>{t('billing.invoices.heading')}</h2>
      <p className="small muted">{t('billing.op.invoiceHint')}</p>
      <ErrorBox error={gen.error} />
      <div className="row">
        <label htmlFor="ob-month">{t('billing.op.month')}</label>
        <input id="ob-month" type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
        <button type="button" onClick={generate} disabled={gen.busy}>{t('billing.op.generate')}</button>
      </div>
      {invoices.length === 0 ? <p className="muted">{t('billing.invoices.none')}</p> : (
        <div className="table-wrap" tabIndex={0}>
          <table>
            <thead>
              <tr>
                <th scope="col">{t('billing.invoices.number')}</th>
                <th scope="col">{t('billing.op.workspace')}</th>
                <th scope="col">{t('billing.invoices.period')}</th>
                <th scope="col">{t('billing.invoices.net')}</th>
                <th scope="col">{t('billing.invoices.gross')}</th>
                <th scope="col">{t('billing.invoices.file')}</th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((i) => (
                <tr key={i.id}>
                  <th scope="row">{i.number}</th>
                  <td>{i.tenantName}</td>
                  <td>{formatDate(i.periodStart)} – {formatDate(i.periodEnd)}</td>
                  <td>{formatEuro(i.netEur, 2)}</td>
                  <td>{formatEuro(i.grossEur, 2)}</td>
                  <td><a href={`/api/operator/billing/invoices/${i.id}/pdf`} download>{t('billing.invoices.pdf')}</a></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
