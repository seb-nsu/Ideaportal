import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../api';
import { ErrorBox, Field, useAction, useLoad } from '../components';
import { intlLocale, labelMap, t } from '../i18n';
import { KIND_LABEL } from './AiPanel';

// Quality dashboard of the AI (R4-08): hit rate, correction rate, source errors, failures and
// costs per agent and week or month, the history of twelve periods and the alarm on deterioration.
// Aggregated per agent; ratings only from the minimum group size on, never per person.

type Granularity = 'week' | 'month';
interface PeriodMetric {
  period: string;
  calls: number;
  errors: number;
  errorRate: number | null;
  costEur: number;
  costPerCall: number | null;
  hitBase: number;
  hits: number;
  hitRate: number | null;
  ratings: number;
  helpful: number | null;
  helpfulRate: number | null;
  claims: number;
  corrected: number;
  correctionRate: number | null;
  sourceChecks: number;
  sourceErrors: number;
  sourceErrorRate: number | null;
}
const METRICS = ['hitRate', 'helpfulRate', 'correctionRate', 'sourceErrorRate', 'errorRate', 'costPerCall'] as const;
type Metric = (typeof METRICS)[number];
interface Finding { agent: string; label: string; metric: Metric; before: number; after: number }
interface AlarmSettings { enabled: boolean; period: Granularity; dropPoints: number; costRisePercent: number; minCases: number }
interface Dashboard {
  granularity: Granularity;
  periods: string[];
  current: string;
  evaluated: string;
  minGroupSize: number;
  alarm: AlarmSettings;
  agents: { agent: string; label: string; series: PeriodMetric[]; latest: PeriodMetric | null; baseline: PeriodMetric | null; findings: Finding[] }[];
  findings: Finding[];
  alarms: { id: string; granularity: Granularity; period: string; findings: Finding[]; createdAt: string }[];
}

const pct = (n: number | null | undefined) => (n == null ? '–' : `${Math.round(n * 100)} %`);
const eur = (n: number | null | undefined, digits = 4) => (n == null ? '–' : new Intl.NumberFormat(intlLocale(), { style: 'currency', currency: 'EUR', minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n));

/** "2026-09" or "2026-W41" (ISO week). */
function periodLabel(start: string, g: Granularity): string {
  if (g === 'month') return start.slice(0, 7);
  const d = new Date(`${start}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 3);
  const year = d.getUTCFullYear();
  const day = Math.round((d.getTime() - Date.UTC(year, 0, 1, 12)) / 86_400_000);
  return `${year}-W${String(Math.ceil((day + 1) / 7)).padStart(2, '0')}`;
}

const agentLabel = (a: { agent: string; label: string }) => KIND_LABEL[a.agent] ?? a.label;
const findingValue = (f: Finding) => (f.metric === 'costPerCall' ? [eur(f.before), eur(f.after)] : [pct(f.before), pct(f.after)]);

function cells(m: PeriodMetric | null, minGroup: number) {
  if (!m) return null;
  return (
    <>
      <td>{m.calls}</td>
      <td>{m.hitBase ? t('aiDashboard.ofN', { value: pct(m.hitRate), n: m.hitBase }) : '–'}</td>
      <td>{m.helpfulRate != null ? t('aiDashboard.ofN', { value: pct(m.helpfulRate), n: m.ratings }) : m.ratings ? t('aiDashboard.belowMin', { n: minGroup }) : '–'}</td>
      <td>{m.claims ? t('aiDashboard.ofN', { value: pct(m.correctionRate), n: m.claims }) : '–'}</td>
      <td>{m.sourceChecks ? t('aiDashboard.ofN', { value: pct(m.sourceErrorRate), n: m.sourceChecks }) : '–'}</td>
      <td>{m.calls ? pct(m.errorRate) : '–'}</td>
      <td>{eur(m.costPerCall)}</td>
      <td>{eur(m.costEur, 2)}</td>
    </>
  );
}

function MetricHead() {
  return (
    <>
      <th scope="col">{t('aiDashboard.col.calls')}</th>
      <th scope="col">{t('aiDashboard.col.hitRate')}</th>
      <th scope="col">{t('aiDashboard.col.helpful')}</th>
      <th scope="col">{t('aiDashboard.col.correctionRate')}</th>
      <th scope="col">{t('aiDashboard.col.sourceErrors')}</th>
      <th scope="col">{t('aiDashboard.col.errorRate')}</th>
      <th scope="col">{t('aiDashboard.col.costPerCall')}</th>
      <th scope="col">{t('aiDashboard.col.cost')}</th>
    </>
  );
}

function AlarmForm({ initial, onSaved }: { initial: AlarmSettings; onSaved: (a: AlarmSettings) => void }) {
  const [a, setA] = useState(initial);
  const [saved, setSaved] = useState(false);
  const save = useAction();
  useEffect(() => setA(initial), [initial]);
  const GRAN = labelMap('aiDashboard.granularity', ['week', 'month'] as const);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaved(false);
    if (await save.run(() => api.put('/api/admin/ai/quality/alarm', a))) {
      setSaved(true);
      onSaved(a);
    }
  };
  return (
    <form onSubmit={submit} className="stack" aria-labelledby="h-ai-alarm">
      <h4 id="h-ai-alarm">{t('aiDashboard.alarm.title')}</h4>
      <p className="small muted">{t('aiDashboard.alarm.hint')}</p>
      <label className="check"><input type="checkbox" checked={a.enabled} onChange={(e) => setA({ ...a, enabled: e.target.checked })} /> {t('aiDashboard.alarm.enabled')}</label>
      <div className="grid grid-3">
        <Field id="alarm-period" label={t('aiDashboard.alarm.period')}>
          <select id="alarm-period" value={a.period} onChange={(e) => setA({ ...a, period: e.target.value as Granularity })}>
            <option value="week">{GRAN.week}</option>
            <option value="month">{GRAN.month}</option>
          </select>
        </Field>
        <Field id="alarm-drop" label={t('aiDashboard.alarm.dropPoints')}>
          <input id="alarm-drop" type="number" min={1} max={100} value={a.dropPoints} onChange={(e) => setA({ ...a, dropPoints: Number(e.target.value) })} />
        </Field>
        <Field id="alarm-cost" label={t('aiDashboard.alarm.costRise')}>
          <input id="alarm-cost" type="number" min={1} max={1000} value={a.costRisePercent} onChange={(e) => setA({ ...a, costRisePercent: Number(e.target.value) })} />
        </Field>
        <Field id="alarm-min" label={t('aiDashboard.alarm.minCases')}>
          <input id="alarm-min" type="number" min={1} max={1000} value={a.minCases} onChange={(e) => setA({ ...a, minCases: Number(e.target.value) })} />
        </Field>
      </div>
      <ErrorBox error={save.error} />
      {saved && <div className="alert info" role="status">{t('aiDashboard.alarm.saved')}</div>}
      <div><button type="submit" disabled={save.busy}>{t('aiDashboard.alarm.save')}</button></div>
    </form>
  );
}

export function QualityDashboard({ onAlarmSaved }: { onAlarmSaved?: (a: AlarmSettings) => void }) {
  const [g, setG] = useState<Granularity | null>(null);
  const { data, error, reload } = useLoad<Dashboard>(`/api/admin/ai/quality/dashboard${g ? `?granularity=${g}` : ''}`);
  const [agent, setAgent] = useState<string>('');
  const GRAN = labelMap('aiDashboard.granularity', ['week', 'month'] as const);
  const METRIC = labelMap('aiDashboard.metric', METRICS);
  if (!data) return <section className="card"><ErrorBox error={error} /></section>;
  const gran = data.granularity;
  const selected = data.agents.find((a) => a.agent === agent) ?? data.agents[0];
  return (
    <section className="card stack" aria-labelledby="h-ai-dashboard">
      <h3 id="h-ai-dashboard">{t('aiDashboard.title')}</h3>
      <p className="small muted">{t('aiDashboard.intro', { n: data.minGroupSize })}</p>
      <Field id="dash-granularity" label={t('aiDashboard.granularityLabel')}>
        <select id="dash-granularity" value={gran} onChange={(e) => setG(e.target.value as Granularity)}>
          <option value="week">{GRAN.week}</option>
          <option value="month">{GRAN.month}</option>
        </select>
      </Field>

      {data.findings.length > 0 ? (
        <div className="alert warn" role="status">
          <strong>{t('aiDashboard.findings', { period: periodLabel(data.evaluated, gran) })}</strong>
          <ul>
            {data.findings.map((f, i) => {
              const [before, after] = findingValue(f);
              return <li key={i}>{t('aiDashboard.finding', { agent: agentLabel(f), metric: METRIC[f.metric], before, after })}</li>;
            })}
          </ul>
        </div>
      ) : (
        data.agents.length > 0 && <p className="small">{t('aiDashboard.noFindings', { period: periodLabel(data.evaluated, gran) })}</p>
      )}

      {data.agents.length === 0 ? <p className="small muted">{t('aiDashboard.empty')}</p> : (
        <>
          <h4>{t('aiDashboard.perAgent', { period: periodLabel(data.evaluated, gran) })}</h4>
          <p className="small muted">{t('aiDashboard.perAgentHint')}</p>
          <div className="table-wrap" tabIndex={0}>
            <table>
              <caption className="sr-only">{t('aiDashboard.perAgentCaption')}</caption>
              <thead><tr><th scope="col">{t('aiDashboard.col.agent')}</th><MetricHead /></tr></thead>
              <tbody>
                {data.agents.map((a) => (
                  <tr key={a.agent}>
                    <th scope="row">{agentLabel(a)}{a.findings.length > 0 && <> <span className="badge red">{t('aiDashboard.worse')}</span></>}</th>
                    {cells(a.latest, data.minGroupSize)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h4>{t('aiDashboard.history')}</h4>
          <Field id="dash-agent" label={t('aiDashboard.agentLabel')}>
            <select id="dash-agent" value={selected.agent} onChange={(e) => setAgent(e.target.value)}>
              {data.agents.map((a) => <option key={a.agent} value={a.agent}>{agentLabel(a)}</option>)}
            </select>
          </Field>
          <div className="table-wrap" tabIndex={0}>
            <table>
              <caption className="sr-only">{t('aiDashboard.historyCaption', { agent: agentLabel(selected) })}</caption>
              <thead><tr><th scope="col">{t('aiDashboard.col.period')}</th><MetricHead /></tr></thead>
              <tbody>
                {[...selected.series].reverse().map((m) => (
                  <tr key={m.period}>
                    <th scope="row">{periodLabel(m.period, gran)}{m.period === data.current ? ` ${t('aiDashboard.running')}` : ''}</th>
                    {cells(m, data.minGroupSize)}
                  </tr>
                ))}
                {selected.baseline && (
                  <tr>
                    <th scope="row">{t('aiDashboard.baseline')}</th>
                    {cells(selected.baseline, data.minGroupSize)}
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      <AlarmForm initial={data.alarm} onSaved={(a) => { onAlarmSaved?.(a); void reload(); }} />

      <h4>{t('aiDashboard.alarms.title')}</h4>
      {data.alarms.length === 0 ? <p className="small muted">{t('aiDashboard.alarms.empty')}</p> : (
        <ul className="idea-list">
          {data.alarms.map((a) => (
            <li key={a.id}>
              <strong>{periodLabel(a.period, a.granularity)}</strong> · {new Date(a.createdAt).toLocaleDateString(intlLocale())}
              <ul className="small">
                {a.findings.map((f, i) => {
                  const [before, after] = findingValue(f);
                  return <li key={i}>{t('aiDashboard.finding', { agent: agentLabel(f), metric: METRIC[f.metric], before, after })}</li>;
                })}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
