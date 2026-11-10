import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { ErrorBox, Field, Loading, useAction, useLoad } from '../components';
import { formatDate, formatEuro, formatNumber, labelMap, t, tn } from '../i18n';
import { FEATURES, type Feature, type PlanInfo } from '../plan';

// Package of the workspace for admins (R3-05, R3-06, R3-02, R3-39): package and status, AI
// quota of the month, features, price sheet, package request, invoice drafts and the export
// of the challenge package. The provider sets the package; there is no online payment.

const PLAN_IDS = ['internal', 'trial', 'team', 'business_1000', 'business_2500', 'enterprise', 'challenge'] as const;
const PLAN_LABELS = labelMap('billing.plan', PLAN_IDS);
const FEATURE_LABELS = labelMap('billing.feature', FEATURES);
const STATUS_LABELS = labelMap('billing.status', ['trial', 'active', 'read_only', 'ended'] as const);

interface Usage {
  month: string;
  limit: number | null;
  included: number | null;
  topups: number;
  used: number;
  percent: number | null;
  costEur: number;
}

interface CatalogueEntry {
  id: (typeof PLAN_IDS)[number];
  priceEur: number | null;
  billing: 'none' | 'monthly' | 'once';
  maxEmployees: number | null;
  fullAnalysesPerMonth: number | null;
  durationDays: number | null;
  features: Partial<Record<Feature, boolean>>;
}

interface Invoice {
  id: string;
  number: string;
  kind: 'monthly' | 'challenge';
  periodStart: string;
  periodEnd: string;
  plan: string;
  netEur: number;
  vatEur: number;
  grossEur: number;
  status: 'draft';
}

interface Billing extends PlanInfo {
  employees: number | null;
  startsOn: string | null;
  priceEur: number | null;
  usage: Usage;
  request: { plan: string; employees: number | null; at: string } | null;
  offer: boolean;
  catalogue: CatalogueEntry[];
  invoices: Invoice[];
  topups: { period: string; analyses: number; priceEur: number; createdAt: string }[];
}

export function BillingAdmin() {
  const { data, error, loading, reload } = useLoad<Billing>('/api/billing');
  if (loading && !data) return <Loading />;
  if (!data) return <ErrorBox error={error} />;
  const internal = data.plan === 'internal';
  return (
    <div className="stack">
      <section className="card" aria-labelledby="h-plan">
        <h2 id="h-plan" style={{ marginTop: 0 }}>{t('billing.current.heading')}</h2>
        {data.offer && (
          <div className="alert info" role="status">
            <strong>{t('billing.offer.heading')}</strong> {t('billing.offer.text')}
          </div>
        )}
        {data.readOnly && !data.offer && <div className="alert warn" role="status">{t('billing.banner.readOnly')}</div>}
        <dl className="facts">
          <dt>{t('billing.current.plan')}</dt>
          <dd>{PLAN_LABELS[data.plan]} <span className={`badge ${data.readOnly ? 'yellow' : 'green'}`}>{STATUS_LABELS[data.status]}</span></dd>
          {data.employees != null && (<><dt>{t('billing.current.employees')}</dt><dd>{formatNumber(data.employees)}</dd></>)}
          {data.priceEur != null && (<><dt>{t('billing.current.price')}</dt><dd>{data.plan === 'challenge' ? t('billing.price.once', { price: formatEuro(data.priceEur) }) : t('billing.price.monthly', { price: formatEuro(data.priceEur) })}</dd></>)}
          {data.trialEndsOn && (<><dt>{t('billing.current.trialEnds')}</dt><dd>{formatDate(data.trialEndsOn)}{data.trialDaysLeft != null && !data.readOnly ? ` (${tn('billing.daysLeft', data.trialDaysLeft)})` : ''}</dd></>)}
          {data.endsOn && (<><dt>{t('billing.current.ends')}</dt><dd>{formatDate(data.endsOn)}</dd></>)}
        </dl>
        {internal && <p className="small muted" style={{ marginBottom: 0 }}>{t('billing.current.internal')}</p>}
      </section>

      <QuotaCard usage={data.usage} />

      <section className="card" aria-labelledby="h-features">
        <h2 id="h-features" style={{ marginTop: 0 }}>{t('billing.features.heading')}</h2>
        <ul className="plain-list">
          {FEATURES.filter((f) => f !== 'moduleZ' || data.features[f]).map((f) => (
            <li key={f}>
              <span className={`badge ${data.features[f] ? 'green' : ''}`}>{data.features[f] ? t('billing.features.on') : t('billing.features.off')}</span>{' '}
              {FEATURE_LABELS[f]}
            </li>
          ))}
        </ul>
        <p className="small muted" style={{ marginBottom: 0 }}>{t('billing.features.moduleZ')}</p>
      </section>

      {data.plan === 'challenge' && <ChallengeExport />}

      {!internal && <RequestForm data={data} onDone={() => void reload()} />}

      <PriceSheet catalogue={data.catalogue} />

      {!internal && <Invoices invoices={data.invoices} />}
    </div>
  );
}

function QuotaCard({ usage }: { usage: Usage }) {
  const pct = usage.percent ?? 0;
  return (
    <section className="card" aria-labelledby="h-quota">
      <h2 id="h-quota" style={{ marginTop: 0 }}>{t('billing.quota.heading')}</h2>
      {usage.limit == null ? (
        <p>{t('billing.quota.none', { used: usage.used })}</p>
      ) : (
        <>
          <p>{t('billing.quota.used', { used: usage.used, limit: usage.limit, percent: pct })}</p>
          <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, pct)} aria-label={t('billing.quota.heading')}>
            <span className={pct >= 100 ? 'full' : pct >= 80 ? 'high' : ''} style={{ width: `${Math.min(100, pct)}%` }} />
          </div>
          {usage.topups > 0 && <p className="small muted">{t('billing.quota.topups', { included: usage.included ?? 0, topups: usage.topups })}</p>}
          {pct >= 100 && <div className="alert warn" role="status" style={{ marginTop: 10 }}>{t('billing.quota.full')}</div>}
        </>
      )}
      <p className="small muted" style={{ marginBottom: 0 }}>{t('billing.quota.hint', { cost: formatEuro(usage.costEur, 2) })}</p>
    </section>
  );
}

function ChallengeExport() {
  return (
    <section className="card" aria-labelledby="h-export">
      <h2 id="h-export" style={{ marginTop: 0 }}>{t('billing.export.heading')}</h2>
      <p>{t('billing.export.text')}</p>
      <p style={{ marginBottom: 0 }}>
        <a href="/api/billing/challenge-export?format=csv" download>{t('billing.export.csv')}</a>{' · '}
        <a href="/api/billing/challenge-export?format=pdf" download>{t('billing.export.pdf')}</a>
      </p>
    </section>
  );
}

function RequestForm({ data, onDone }: { data: Billing; onDone: () => void }) {
  const [plan, setPlan] = useState<string>(data.plan === 'challenge' || data.plan === 'trial' ? 'team' : data.plan);
  const [employees, setEmployees] = useState<string>(data.employees ? String(data.employees) : '');
  const [sent, setSent] = useState(false);
  const { busy, error, run } = useAction();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const ok = await run(() => api.post('/api/billing/request', { plan, employees: employees ? Number(employees) : null }));
    if (ok) {
      setSent(true);
      onDone();
    }
  };
  return (
    <form className="card" onSubmit={submit} aria-labelledby="h-request">
      <h2 id="h-request" style={{ marginTop: 0 }}>{t('billing.request.heading')}</h2>
      <p className="small muted">{t('billing.request.hint')}</p>
      <ErrorBox error={error} />
      {(sent || data.request) && (
        <div className="alert success" role="status">
          {t('billing.request.pending', { plan: PLAN_LABELS[data.request?.plan ?? plan] ?? plan })}
        </div>
      )}
      <div className="grid grid-3">
        <Field id="billing-plan" label={t('billing.request.plan')}>
          <select id="billing-plan" value={plan} onChange={(e) => setPlan(e.target.value)}>
            {data.catalogue.map((c) => <option key={c.id} value={c.id}>{PLAN_LABELS[c.id]}</option>)}
          </select>
        </Field>
        <Field id="billing-employees" label={t('billing.request.employees')}>
          <input id="billing-employees" type="number" min={1} value={employees} onChange={(e) => setEmployees(e.target.value)} />
        </Field>
      </div>
      <button type="submit" className="primary" disabled={busy}>{t('billing.request.submit')}</button>
    </form>
  );
}

function PriceSheet({ catalogue }: { catalogue: CatalogueEntry[] }) {
  return (
    <section className="card" aria-labelledby="h-prices">
      <h2 id="h-prices" style={{ marginTop: 0 }}>{t('billing.prices.heading')}</h2>
      <div className="table-wrap" tabIndex={0}>
        <table>
          <caption className="sr-only">{t('billing.prices.heading')}</caption>
          <thead>
            <tr>
              <th scope="col">{t('billing.prices.plan')}</th>
              <th scope="col">{t('billing.prices.price')}</th>
              <th scope="col">{t('billing.prices.analyses')}</th>
              <th scope="col">{t('billing.prices.features')}</th>
            </tr>
          </thead>
          <tbody>
            {catalogue.map((c) => (
              <tr key={c.id}>
                <th scope="row">{PLAN_LABELS[c.id]}</th>
                <td>{c.priceEur == null ? '–' : c.billing === 'once' ? t('billing.price.once', { price: formatEuro(c.priceEur) }) : t(c.id === 'enterprise' ? 'billing.price.from' : 'billing.price.monthly', { price: formatEuro(c.priceEur) })}</td>
                <td>{c.fullAnalysesPerMonth == null ? '–' : c.billing === 'once' ? t('billing.prices.analysesOnce', { n: c.fullAnalysesPerMonth }) : t('billing.prices.analysesMonth', { n: c.fullAnalysesPerMonth })}</td>
                <td>{FEATURES.filter((f) => c.features[f]).map((f) => FEATURE_LABELS[f]).join(', ') || t('billing.prices.core')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="small muted" style={{ marginBottom: 0 }}>{t('billing.prices.note')}</p>
    </section>
  );
}

function Invoices({ invoices }: { invoices: Invoice[] }) {
  return (
    <section className="card" aria-labelledby="h-invoices">
      <h2 id="h-invoices" style={{ marginTop: 0 }}>{t('billing.invoices.heading')}</h2>
      <p className="small muted">{t('billing.invoices.hint')}</p>
      {invoices.length === 0 ? (
        <p className="muted" style={{ marginBottom: 0 }}>{t('billing.invoices.none')}</p>
      ) : (
        <div className="table-wrap" tabIndex={0}>
          <table>
            <caption className="sr-only">{t('billing.invoices.heading')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('billing.invoices.number')}</th>
                <th scope="col">{t('billing.invoices.period')}</th>
                <th scope="col">{t('billing.invoices.net')}</th>
                <th scope="col">{t('billing.invoices.gross')}</th>
                <th scope="col">{t('billing.invoices.file')}</th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((i) => (
                <tr key={i.id}>
                  <th scope="row">{i.number} <span className="badge">{t('billing.invoices.draft')}</span></th>
                  <td>{formatDate(i.periodStart)} – {formatDate(i.periodEnd)}</td>
                  <td>{formatEuro(i.netEur, 2)}</td>
                  <td>{formatEuro(i.grossEur, 2)}</td>
                  <td><a href={`/api/billing/invoices/${i.id}/pdf`} download>{t('billing.invoices.pdf')}</a></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
