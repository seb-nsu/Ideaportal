import { useState } from 'react';
import { ErrorBox, Loading, useLoad } from '../components';
import { BENEFIT } from '../labels';
import { useSession } from '../session';
import { formatNumber, t } from '../i18n';

interface DashboardData {
  from: string;
  to: string;
  submitted: number;
  funnel: { status: string; label: string; count: number }[];
  deadlineAdherence: { total: number; onTime: number; rate: number } | null;
  avgDaysToGate1: number | null;
  realization: { approved: number; completed: number; rate: number } | null;
  benefit: { kind: string; total: number; count: number }[];
  gate2Decisions?: { committee: number; delegated: number };
  satisfaction: { avg: number | null; count: number };
  byUnit: { unit: string; ideas: number | null; merged: boolean }[];
  minGroupSize: number;
  throughput: Throughput[];
  baselineNote: string;
}

interface Throughput {
  section: string;
  label: string;
  count: number;
  medianDays: number | null;
  p90Days: number | null;
  baselineDays: number | null;
  series: { month: string; count: number; medianDays: number }[];
}

interface ChallengeLine {
  id: string;
  title: string;
  startsOn: string;
  endsOn: string;
  ideas: number;
  participants: number | null;
  decided: number;
  implemented: number;
  /** total = reported (estimated), confirmed = confirmed by controlling (R3-33). */
  benefit: { kind: string; total: number; confirmed?: number }[];
  target?: { kind: string; value: number; estimated: number; confirmed: number } | null;
  medianDaysToGate1: number | null;
}

const days = (n: number | null) => (n == null ? '–' : t('dashboard.days', { n: formatNumber(n) }));

// Dashboard with flow, deadline adherence, throughput, realization, benefit and satisfaction (R1-37).
export function Dashboard() {
  const { settings } = useSession();
  const lastYear = `${Number(settings.today.slice(0, 4)) - 1}${settings.today.slice(4)}`;
  const [from, setFrom] = useState(lastYear);
  const [to, setTo] = useState(settings.today);
  // Area filter (R3-29): tenant-wide roles choose any area, scoped roles only see their own.
  const [areaId, setAreaId] = useState('');
  const areas = useLoad<{ items: { id: string; name: string }[]; restricted: boolean }>('/api/dashboard/areas');
  const query = `from=${from}&to=${to}${areaId ? `&areaId=${areaId}` : ''}`;
  const { data, error, loading } = useLoad<DashboardData>(`/api/dashboard?${query}`);
  const challenges = useLoad<{ items: ChallengeLine[]; minGroupSize: number }>(`/api/dashboard/challenges?${query}`);
  const max = Math.max(1, ...(data?.funnel.map((f) => f.count) ?? [1]));
  return (
    <div className="stack">
      <div className="row spread">
        <h1>{t('dashboard.title')}</h1>
        <a className="button" href={`/api/dashboard.csv?${query}`}>{t('dashboard.exportCsv')}</a>
      </div>
      <div className="card row">
        <div><label htmlFor="from">{t('dashboard.from')}</label><input id="from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
        <div><label htmlFor="to">{t('dashboard.to')}</label><input id="to" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
        {!!areas.data?.items.length && (
          <div>
            <label htmlFor="area">{t('areas.filter')}</label>
            <select id="area" value={areaId} onChange={(e) => setAreaId(e.target.value)}>
              <option value="">{areas.data.restricted ? t('areas.filterMine') : t('areas.filterAll')}</option>
              {areas.data.items.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </div>
        )}
        <p className="small muted" style={{ alignSelf: 'flex-end' }}>
          {t('dashboard.aggregatedNote', { n: data?.minGroupSize ?? 5 })}{areas.data?.restricted ? ` ${t('areas.dashboardHint')}` : ''}
        </p>
      </div>
      <ErrorBox error={error} />
      {loading && !data ? <Loading /> : data && (
        <>
          <div className="grid grid-3">
            <Kpi label={t('dashboard.kpi.submitted')} value={String(data.submitted)} />
            <Kpi label={t('dashboard.kpi.adherence')} value={data.deadlineAdherence ? t('dashboard.percent', { n: data.deadlineAdherence.rate }) : '–'} hint={data.deadlineAdherence ? t('dashboard.kpi.adherenceHint', { onTime: data.deadlineAdherence.onTime, total: data.deadlineAdherence.total }) : t('dashboard.kpi.noDecisions')} />
            <Kpi label={t('dashboard.kpi.avgDays')} value={formatNumber(data.avgDaysToGate1)} hint={t('dashboard.kpi.calendarDays')} />
            <Kpi label={t('dashboard.kpi.realization')} value={data.realization ? t('dashboard.percent', { n: data.realization.rate }) : '–'} hint={data.realization ? t('dashboard.kpi.realizationHint', { completed: data.realization.completed, approved: data.realization.approved }) : undefined} />
            {data.gate2Decisions && (
              <Kpi
                label={t('dashboard.kpi.gate2')}
                value={String(data.gate2Decisions.committee + data.gate2Decisions.delegated)}
                hint={t('dashboard.kpi.gate2Hint', { committee: data.gate2Decisions.committee, delegated: data.gate2Decisions.delegated })}
              />
            )}
            <Kpi label={t('dashboard.kpi.satisfaction')} value={data.satisfaction.avg != null ? t('dashboard.kpi.satisfactionValue', { avg: formatNumber(data.satisfaction.avg) }) : '–'} hint={data.satisfaction.avg == null ? t('dashboard.kpi.satisfactionHidden', { n: data.minGroupSize }) : t('dashboard.kpi.ratings', { n: data.satisfaction.count })} />
          </div>
          <div className="grid grid-2">
            <section className="card">
              <h2>{t('dashboard.flow')}</h2>
              <div className="table-wrap" tabIndex={0}><table>
                <caption className="sr-only">{t('dashboard.flowCaption')}</caption>
                <tbody>
                  {data.funnel.map((f) => (
                    <tr key={f.status}>
                      <th scope="row" style={{ width: '40%' }}>{f.label}</th>
                      <td>
                        <div className="row">
                          <div className="progress" style={{ flex: 1 }} aria-hidden="true"><span style={{ width: `${(f.count / max) * 100}%`, background: 'var(--accent)' }} /></div>
                          <span>{f.count}</span>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table></div>
            </section>
            <section className="card">
              <h2>{t('dashboard.benefit')}</h2>
              {data.benefit.length === 0 ? <p className="muted">{t('dashboard.noBenefit')}</p> : (
                <div className="table-wrap" tabIndex={0}><table>
                  <thead><tr><th>{t('dashboard.benefitKind')}</th><th>{t('dashboard.sum')}</th><th>{t('dashboard.implementations')}</th></tr></thead>
                  <tbody>
                    {data.benefit.map((b) => (
                      <tr key={b.kind}><td>{BENEFIT[b.kind] ?? b.kind}</td><td>{b.kind === 'quality' ? '–' : formatNumber(b.total)}</td><td>{b.count}</td></tr>
                    ))}
                  </tbody>
                </table></div>
              )}
              <h2 style={{ marginTop: 20 }}>{t('dashboard.byUnit')}</h2>
              <div className="table-wrap" tabIndex={0}><table>
                <thead><tr><th>{t('dashboard.unit')}</th><th>{t('dashboard.ideas')}</th></tr></thead>
                <tbody>
                  {data.byUnit.map((u) => (
                    <tr key={u.unit}><td>{u.unit}</td><td>{u.ideas ?? t('dashboard.belowGroup', { n: data.minGroupSize })}</td></tr>
                  ))}
                </tbody>
              </table></div>
            </section>
          </div>
          <section className="card" aria-labelledby="h-throughput">
            <h2 id="h-throughput">{t('dashboard.throughput')}</h2>
            <p className="small muted">{t('dashboard.throughputNote', { note: data.baselineNote ? ` (${data.baselineNote})` : '' })}</p>
            <div className="table-wrap" tabIndex={0}>
              <table>
                <caption className="sr-only">{t('dashboard.throughputCaption')}</caption>
                <thead><tr><th scope="col">{t('dashboard.stage')}</th><th scope="col">{t('dashboard.count')}</th><th scope="col">{t('dashboard.median')}</th><th scope="col">{t('dashboard.p90')}</th><th scope="col">{t('dashboard.baseline')}</th></tr></thead>
                <tbody>
                  {data.throughput.map((row) => (
                    <tr key={row.section}><th scope="row">{row.label}</th><td>{row.count}</td><td>{days(row.medianDays)}</td><td>{days(row.p90Days)}</td><td>{days(row.baselineDays)}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="grid grid-2">
              {data.throughput.filter((row) => row.series.length > 0).map((row) => <SeriesChart key={row.section} item={row} />)}
            </div>
          </section>
          <section className="card" aria-labelledby="h-challenges">
            <div className="row spread">
              <h2 id="h-challenges">{t('dashboard.challengeReport')}</h2>
              <a className="button" href={`/api/dashboard/challenges.csv?from=${from}&to=${to}`}>{t('dashboard.exportCsv')}</a>
            </div>
            {!challenges.data?.items.length ? <p className="muted">{t('dashboard.noChallenges')}</p> : (
              <div className="table-wrap" tabIndex={0}>
                <table>
                  <caption className="sr-only">{t('dashboard.challengesCaption')}</caption>
                  <thead><tr><th scope="col">{t('dashboard.challenge')}</th><th scope="col">{t('dashboard.ideas')}</th><th scope="col">{t('dashboard.participants')}</th><th scope="col">{t('dashboard.decided')}</th><th scope="col">{t('dashboard.implemented')}</th><th scope="col">{t('dashboard.medianToGate1')}</th><th scope="col">{t('dashboard.benefit')}</th></tr></thead>
                  <tbody>
                    {challenges.data.items.map((c) => (
                      <tr key={c.id}>
                        <th scope="row">{c.title}<div className="small muted">{t('dashboard.dateRange', { from: c.startsOn, to: c.endsOn })}</div></th>
                        <td>{c.ideas}</td>
                        <td>{c.participants ?? t('dashboard.belowN', { n: challenges.data!.minGroupSize })}</td>
                        <td>{c.decided}</td>
                        <td>{c.implemented}</td>
                        <td>{days(c.medianDaysToGate1)}</td>
                        <td>
                          {c.benefit.length ? c.benefit.map((b) => `${BENEFIT[b.kind] ?? b.kind}: ${formatNumber(b.total)}`).join(', ') : '–'}
                          {c.benefit.length > 0 && (
                            <div className="small muted">{t('usecases.dashboard.confirmed', { list: c.benefit.map((b) => `${BENEFIT[b.kind] ?? b.kind}: ${formatNumber(b.confirmed ?? 0)}`).join(', ') })}</div>
                          )}
                          {c.target && (
                            <div className="small">{t('usecases.dashboard.target', { value: formatNumber(c.target.value), unit: BENEFIT[c.target.kind] ?? c.target.kind, confirmed: formatNumber(c.target.confirmed), estimated: formatNumber(c.target.estimated) })}</div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

/** Monthly median as a line with the baseline as a dashed line; the table below carries the same data. */
function SeriesChart({ item }: { item: Throughput }) {
  const W = 320;
  const H = 140;
  const pad = { l: 36, r: 8, t: 10, b: 24 };
  const values = item.series.map((p) => p.medianDays);
  const top = Math.max(1, ...values, item.baselineDays ?? 0) * 1.15;
  const x = (i: number) => pad.l + (item.series.length === 1 ? (W - pad.l - pad.r) / 2 : (i * (W - pad.l - pad.r)) / (item.series.length - 1));
  const y = (v: number) => pad.t + (H - pad.t - pad.b) * (1 - v / top);
  const points = item.series.map((p, i) => `${x(i)},${y(p.medianDays)}`).join(' ');
  const summary = t('dashboard.chartSummary', {
    label: item.label,
    from: item.series[0].month,
    to: item.series[item.series.length - 1].month,
    last: days(values[values.length - 1]),
    baseline: item.baselineDays != null ? t('dashboard.chartBaseline', { days: days(item.baselineDays) }) : '',
  });
  return (
    <figure className="chart">
      <figcaption className="small"><strong>{item.label}</strong></figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={summary} width="100%">
        <line x1={pad.l} y1={H - pad.b} x2={W - pad.r} y2={H - pad.b} className="chart-axis" />
        <text x={pad.l - 4} y={y(top / 1.15)} className="chart-label" textAnchor="end">{Math.round(top / 1.15)}</text>
        <text x={pad.l - 4} y={H - pad.b} className="chart-label" textAnchor="end">0</text>
        {item.baselineDays != null && <line x1={pad.l} x2={W - pad.r} y1={y(item.baselineDays)} y2={y(item.baselineDays)} className="chart-baseline" />}
        <polyline points={points} className="chart-line" />
        {item.series.map((p, i) => <circle key={p.month} cx={x(i)} cy={y(p.medianDays)} r={3} className="chart-dot" />)}
        <text x={x(0)} y={H - 6} className="chart-label" textAnchor="start">{item.series[0].month}</text>
        {item.series.length > 1 && <text x={x(item.series.length - 1)} y={H - 6} className="chart-label" textAnchor="end">{item.series[item.series.length - 1].month}</text>}
      </svg>
      <details className="small">
        <summary>{t('dashboard.valuesAsTable')}</summary>
        <div className="table-wrap" tabIndex={0}><table>
          <thead><tr><th scope="col">{t('dashboard.month')}</th><th scope="col">{t('dashboard.count')}</th><th scope="col">{t('dashboard.median')}</th></tr></thead>
          <tbody>{item.series.map((p) => <tr key={p.month}><td>{p.month}</td><td>{p.count}</td><td>{days(p.medianDays)}</td></tr>)}</tbody>
        </table></div>
      </details>
    </figure>
  );
}

function Kpi({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="card">
      <div className="muted small">{label}</div>
      <div className="kpi">{value}</div>
      {hint && <div className="small muted">{hint}</div>}
    </div>
  );
}
