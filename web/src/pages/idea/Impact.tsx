import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, api } from '../../api';
import { ErrorBox, Field, Loading, useAction, useLoad } from '../../components';
import { formatDate, formatEuro, formatNumber, parseNumber } from '../../labels';
import { labelMap, t } from '../../i18n';

// Wirkung und Lernen (AP-28): metrics before and after with the report draft for Gate 3 (R4-04)
// and the effort estimate from similar implemented ideas (R4-06).

interface MetricValue {
  id: string;
  value: number;
  periodFrom: string | null;
  periodTo: string | null;
  source: string;
  note: string | null;
}

interface Metric {
  id: string;
  name: string;
  unit: string;
  direction: 'increase' | 'decrease';
  source: 'manual' | 'api' | 'connector';
  connectorName: string | null;
  query: string | null;
  baselineFrom: string;
  baselineTo: string;
  nextMeasureOn: string | null;
  lastError: string | null;
  baseline: MetricValue | null;
  after: MetricValue | null;
  change: number | null;
  changePercent: number | null;
  assessment: 'better' | 'worse' | 'same' | 'open';
}

interface MetricsData {
  metrics: Metric[];
  connectors: { id: string; name: string; kind: string; enabled: boolean }[];
  connectorsAvailable: boolean;
  defaultIntervalDays: number;
  can: { define: boolean; record: boolean };
}

const SOURCE = labelMap('learning.metrics.source', ['manual', 'api', 'connector'] as const);
const DIRECTION = labelMap('learning.metrics.direction', ['increase', 'decrease'] as const);
const ASSESSMENT = labelMap('learning.metrics.assessment', ['better', 'worse', 'same', 'open'] as const);
const ASSESSMENT_BADGE: Record<Metric['assessment'], string> = { better: 'badge green', worse: 'badge red', same: 'badge', open: 'badge' };

const signed = (n: number) => `${n > 0 ? '+' : ''}${formatNumber(n)}`;

function ValueCell({ v, unit }: { v: MetricValue | null; unit: string }) {
  if (!v) return <span className="muted">{t('learning.metrics.notYet')}</span>;
  return (
    <>
      {t('learning.metrics.value', { value: formatNumber(v.value), unit })}
      {v.periodFrom && v.periodTo && <div className="small muted">{t('learning.metrics.period', { from: formatDate(v.periodFrom), to: formatDate(v.periodTo) })}</div>}
    </>
  );
}

export function ImpactMetrics({ ideaId, status }: { ideaId: string; status: string }) {
  const { data, error, reload } = useLoad<MetricsData>(`/api/ideas/${ideaId}/impact-metrics`);
  const [adding, setAdding] = useState(false);
  const [recording, setRecording] = useState<Metric | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const action = useAction();
  if (!data) return error ? <ErrorBox error={error} /> : <Loading />;
  const measure = async (mt: Metric) => {
    setMessage(null);
    const r = await action.run(() => api.post<{ measured: number; error: string | null }>(`/api/ideas/${ideaId}/impact-metrics/${mt.id}/measure`));
    if (r) {
      setMessage(t('learning.metrics.measured', { n: r.measured }));
      void reload();
    }
  };
  const remove = async (mt: Metric) => {
    if (await action.run(() => api.del(`/api/ideas/${ideaId}/impact-metrics/${mt.id}`))) void reload();
  };
  const goneLive = ['completed'].includes(status);
  return (
    <section className="card" aria-labelledby="h-metrics">
      <h2 id="h-metrics">{t('learning.metrics.title')}</h2>
      <p className="muted small">{t('learning.metrics.intro')}</p>
      <ErrorBox error={action.error} />
      {message && <p className="alert success" role="status">{message}</p>}
      {data.metrics.length === 0 && <p className="muted">{data.can.define ? t('learning.metrics.empty') : t('learning.metrics.emptyFixed')}</p>}
      {data.metrics.map((mt) => (
        <div key={mt.id} className="stack" style={{ marginBottom: 16 }}>
          <h3 style={{ margin: 0 }}>{mt.name} <span className={ASSESSMENT_BADGE[mt.assessment]}>{ASSESSMENT[mt.assessment]}</span></h3>
          <p className="small muted" style={{ margin: 0 }}>
            {t('learning.metrics.meta', {
              direction: DIRECTION[mt.direction],
              source: mt.connectorName ? `${SOURCE[mt.source]} ${mt.connectorName}` : SOURCE[mt.source],
              from: formatDate(mt.baselineFrom),
              to: formatDate(mt.baselineTo),
            })}
          </p>
          {mt.query && <p className="small" style={{ margin: 0 }}><code>{mt.query}</code></p>}
          <div className="table-wrap" tabIndex={0}><table>
            <thead><tr><th scope="col">{t('learning.metrics.before')}</th><th scope="col">{t('learning.metrics.after')}</th><th scope="col">{t('learning.metrics.change')}</th></tr></thead>
            <tbody>
              <tr>
                <td><ValueCell v={mt.baseline} unit={mt.unit} /></td>
                <td><ValueCell v={mt.after} unit={mt.unit} /></td>
                <td>{mt.change != null ? t('learning.metrics.changeValue', { change: signed(mt.change), unit: mt.unit, percent: mt.changePercent == null ? '–' : signed(mt.changePercent) }) : '–'}</td>
              </tr>
            </tbody>
          </table></div>
          {mt.source === 'connector' && (
            <p className="small muted" style={{ margin: 0 }}>
              {goneLive ? (mt.nextMeasureOn ? t('learning.metrics.next', { date: formatDate(mt.nextMeasureOn) }) : '') : t('learning.metrics.nextAfterGoLive')}
            </p>
          )}
          {mt.lastError && <p className="small alert error" style={{ margin: 0 }}>{t('learning.metrics.error', { reason: mt.lastError })}</p>}
          {mt.source === 'api' && <p className="small muted" style={{ margin: 0 }}>{t('learning.metrics.apiHint', { url: `/api/impact-metrics/${mt.id}/values` })}</p>}
          <div className="row">
            {mt.source === 'connector' && (data.can.define || data.can.record) && data.connectorsAvailable && (
              <button type="button" disabled={action.busy} onClick={() => measure(mt)}>{t('learning.metrics.measure')}</button>
            )}
            {mt.source !== 'connector' && data.can.record && <button type="button" onClick={() => setRecording(mt)}>{t('learning.metrics.record')}</button>}
            {data.can.define && (
              <button type="button" className="link danger" disabled={action.busy} aria-label={t('learning.metrics.deleteAria', { name: mt.name })} onClick={() => remove(mt)}>
                {t('learning.metrics.delete')}
              </button>
            )}
          </div>
          {recording?.id === mt.id && <RecordValue metric={mt} onClose={() => setRecording(null)} onDone={() => { setRecording(null); void reload(); }} />}
        </div>
      ))}
      {data.can.define && !adding && <button type="button" className="primary" onClick={() => setAdding(true)}>{t('learning.metrics.add')}</button>}
      {adding && <MetricForm ideaId={ideaId} data={data} onClose={() => setAdding(false)} onDone={() => { setAdding(false); void reload(); }} />}
    </section>
  );
}

function MetricForm({ ideaId, data, onClose, onDone }: { ideaId: string; data: MetricsData; onClose: () => void; onDone: () => void }) {
  const [form, setForm] = useState({
    name: '', unit: '', direction: 'decrease', source: 'manual', connectorId: '', query: '', queryTable: '', baselineFrom: '', baselineTo: '',
    intervalDays: String(data.defaultIntervalDays),
  });
  const { busy, error, run } = useAction();
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  const connector = form.source === 'connector';
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const body = {
      name: form.name, unit: form.unit, direction: form.direction, source: form.source, baselineFrom: form.baselineFrom, baselineTo: form.baselineTo,
      intervalDays: Number(form.intervalDays) || undefined,
      ...(connector ? { connectorId: form.connectorId || null, query: form.query, queryTable: form.queryTable || null } : {}),
    };
    if (await run(() => api.post(`/api/ideas/${ideaId}/impact-metrics`, body))) onDone();
  };
  return (
    <form onSubmit={submit} style={{ marginTop: 12 }}>
      <h3>{t('learning.metrics.add')}</h3>
      <ErrorBox error={error} />
      <div className="grid grid-2">
        <Field id="mt-name" label={t('learning.metrics.form.name')} hint={t('learning.metrics.form.nameHint')}>
          <input id="mt-name" type="text" value={form.name} onChange={set('name')} required minLength={2} maxLength={120} />
        </Field>
        <Field id="mt-unit" label={t('learning.metrics.form.unit')}>
          <input id="mt-unit" type="text" value={form.unit} onChange={set('unit')} required maxLength={40} />
        </Field>
        <Field id="mt-direction" label={t('learning.metrics.form.direction')}>
          <select id="mt-direction" value={form.direction} onChange={set('direction')}>
            {(['decrease', 'increase'] as const).map((d) => <option key={d} value={d}>{DIRECTION[d]}</option>)}
          </select>
        </Field>
        <Field id="mt-source" label={t('learning.metrics.form.source')}>
          <select id="mt-source" value={form.source} onChange={set('source')}>
            {(['manual', 'api', 'connector'] as const).map((s) => <option key={s} value={s} disabled={s === 'connector' && !data.connectorsAvailable}>{SOURCE[s]}</option>)}
          </select>
        </Field>
        <Field id="mt-from" label={t('learning.metrics.form.from')}>
          <input id="mt-from" type="date" value={form.baselineFrom} onChange={set('baselineFrom')} required />
        </Field>
        <Field id="mt-to" label={t('learning.metrics.form.to')}>
          <input id="mt-to" type="date" value={form.baselineTo} onChange={set('baselineTo')} required />
        </Field>
      </div>
      {!data.connectorsAvailable && <p className="hint">{t('learning.metrics.form.noConnectorFeature')}</p>}
      {connector && (
        <div className="grid grid-2">
          {data.connectors.length === 0 ? <p className="hint">{t('learning.metrics.form.noConnectors')}</p> : (
            <Field id="mt-connector" label={t('learning.metrics.form.connector')}>
              <select id="mt-connector" value={form.connectorId} onChange={set('connectorId')} required>
                <option value="">{t('learning.metrics.form.chooseConnector')}</option>
                {data.connectors.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </Field>
          )}
          <Field id="mt-interval" label={t('learning.metrics.form.interval')}>
            <input id="mt-interval" type="number" min={1} max={365} value={form.intervalDays} onChange={set('intervalDays')} />
          </Field>
          <Field id="mt-query" label={t('learning.metrics.form.query')} hint={t('learning.metrics.form.queryHint', { from: '{from}', to: '{to}' })}>
            <textarea id="mt-query" value={form.query} onChange={set('query')} required maxLength={2000} />
          </Field>
          <Field id="mt-table" label={t('learning.metrics.form.table')}>
            <input id="mt-table" type="text" value={form.queryTable} onChange={set('queryTable')} pattern="[A-Za-z0-9_]*" maxLength={80} />
          </Field>
        </div>
      )}
      <div className="row">
        <button type="button" onClick={onClose}>{t('learning.metrics.form.cancel')}</button>
        <button className="primary" disabled={busy}>{t('learning.metrics.form.save')}</button>
      </div>
    </form>
  );
}

function RecordValue({ metric, onClose, onDone }: { metric: Metric; onClose: () => void; onDone: () => void }) {
  const [form, setForm] = useState({ period: metric.baseline ? 'after' : 'baseline', value: '', note: '' });
  const { busy, error, run, setError } = useAction();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const value = parseNumber(form.value);
    if (value == null || Number.isNaN(value)) return setError(new ApiError(400, t('learning.metrics.form.number')));
    if (await run(() => api.post(`/api/impact-metrics/${metric.id}/values`, { period: form.period, value, note: form.note || undefined }))) onDone();
  };
  const p = `rv-${metric.id}`;
  return (
    <form onSubmit={submit}>
      <h4 style={{ margin: 0 }}>{t('learning.metrics.recordFor', { name: metric.name })}</h4>
      <ErrorBox error={error} />
      <div className="grid grid-3">
        <Field id={`${p}-period`} label={t('learning.metrics.form.period')}>
          <select id={`${p}-period`} value={form.period} onChange={(e) => setForm({ ...form, period: e.target.value })}>
            <option value="baseline">{t('learning.metrics.form.periodBaseline')}</option>
            <option value="after">{t('learning.metrics.form.periodAfter')}</option>
          </select>
        </Field>
        <Field id={`${p}-value`} label={`${t('learning.metrics.form.value')} (${metric.unit})`}>
          <input id={`${p}-value`} type="text" inputMode="decimal" value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} required />
        </Field>
        <Field id={`${p}-note`} label={t('learning.metrics.form.note')}>
          <input id={`${p}-note`} type="text" maxLength={500} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
        </Field>
      </div>
      <div className="row">
        <button type="button" onClick={onClose}>{t('learning.metrics.form.cancel')}</button>
        <button className="primary" disabled={busy}>{t('learning.metrics.record')}</button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------- report draft for Gate 3 (R4-04)

export function ImpactReportDraft({ ideaId }: { ideaId: string }) {
  const { data, error } = useLoad<{ text: string }>(`/api/ideas/${ideaId}/impact-report`);
  const [copied, setCopied] = useState(false);
  if (!data) return error ? <ErrorBox error={error} /> : null;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(data.text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <section className="card" aria-labelledby="h-impact-draft">
      <h2 id="h-impact-draft">{t('learning.report.title')}</h2>
      <p className="muted small">{t('learning.report.intro')}</p>
      <Field id="impact-draft" label={t('learning.report.label')}>
        <textarea id="impact-draft" readOnly rows={Math.min(16, data.text.split('\n').length + 1)} value={data.text} />
      </Field>
      <div className="row">
        <button type="button" onClick={copy}>{t('learning.report.copy')}</button>
        {copied && <span role="status" className="small">{t('learning.report.copied')}</span>}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- effort estimate (R4-06)

interface Spread { low: number; median: number; high: number; min: number; max: number }
interface Estimate {
  enough: boolean;
  minReferences: number;
  references: { id: string; number: number; title: string; score: number; personDays: number | null; euro: number | null; actual: boolean }[];
  range: { personDays: Spread | null; euro: Spread | null } | null;
  own: { personDays: number | null; euro: number | null };
}

export function EffortEstimate({ ideaId }: { ideaId: string }) {
  const { data } = useLoad<Estimate>(`/api/ideas/${ideaId}/effort-estimate`);
  // People without access (403) simply do not see the card.
  if (!data) return null;
  const pd = data.range?.personDays;
  const eu = data.range?.euro;
  return (
    <section className="card" aria-labelledby="h-effort-est">
      <h2 id="h-effort-est">{t('learning.effort.title')}</h2>
      {!data.enough ? (
        <p className="muted">{t('learning.effort.notEnough', { min: data.minReferences, n: data.references.length })}</p>
      ) : (
        <>
          {pd && <p>{t('learning.effort.range', { low: formatNumber(pd.low), high: formatNumber(pd.high), median: formatNumber(pd.median) })}</p>}
          {eu && <p>{t('learning.effort.rangeEuro', { low: formatEuro(eu.low), high: formatEuro(eu.high), median: formatEuro(eu.median) })}</p>}
        </>
      )}
      <p className="small">
        {data.own.personDays != null || data.own.euro != null
          ? t('learning.effort.own', { days: formatNumber(data.own.personDays), euro: formatEuro(data.own.euro) })
          : t('learning.effort.ownNone')}
      </p>
      {data.references.length > 0 && (
        <div className="table-wrap" tabIndex={0}><table>
          <caption className="sr-only">{t('learning.effort.references')}</caption>
          <thead>
            <tr>
              <th scope="col">{t('learning.effort.col.idea')}</th>
              <th scope="col">{t('learning.effort.col.days')}</th>
              <th scope="col">{t('learning.effort.col.euro')}</th>
              <th scope="col">{t('learning.effort.col.basis')}</th>
              <th scope="col">{t('learning.effort.col.score')}</th>
            </tr>
          </thead>
          <tbody>
            {data.references.map((r) => (
              <tr key={r.id}>
                <td><Link to={`/ideen/${r.id}`}>#{r.number} {r.title}</Link></td>
                <td>{formatNumber(r.personDays)}</td>
                <td>{formatEuro(r.euro)}</td>
                <td>{r.actual ? t('learning.effort.actual') : t('learning.effort.estimate')}</td>
                <td>{formatNumber(Math.round(r.score * 100))} %</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
      <p className="hint">{t('learning.effort.hint')}</p>
    </section>
  );
}

// ---------------------------------------------------------------- hit band in the committee pack (R4-07)

export interface ItemCalibration {
  enough: boolean;
  band?: { ideaType: string; n: number; low: number; high: number; median: number; hitRate: number };
  expected?: { low: number; median: number; high: number } | null;
}

const TYPE = labelMap('learning.calibration.type', ['internal', 'product'] as const);

/** One line in the benefit column of the committee comparison. */
export function HitBand({ c, pack }: { c: ItemCalibration | undefined; pack: { enough: boolean; closed: number; minClosed: number } | undefined }) {
  if (!c || !pack) return null;
  if (!pack.enough) return <div className="small muted">{t('learning.band.notEnough', { min: pack.minClosed, n: pack.closed })}</div>;
  if (!c.enough || !c.band) return <div className="small muted">{t('learning.band.typeTooFew')}</div>;
  const b = c.band;
  return (
    <div className="small">
      <span className="muted">{t('learning.band.text', { type: TYPE[b.ideaType], low: Math.round(b.low * 100), high: Math.round(b.high * 100), n: b.n, hit: Math.round(b.hitRate * 100) })}</span>
      {c.expected && <div>{t('learning.band.label')}: {t('learning.band.expected', { low: formatEuro(c.expected.low), high: formatEuro(c.expected.high) })}</div>}
    </div>
  );
}
