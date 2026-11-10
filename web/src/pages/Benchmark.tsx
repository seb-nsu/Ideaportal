import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { ErrorBox, Loading, useLoad } from '../components';
import { LanguageSwitch } from '../LanguageSwitch';
import { formatDate, formatNumber, t, type MessageKey } from '../i18n';

// Public benchmark page (R3-40): anonymised figures across consenting workspaces, one snapshot
// per finished quarter. No sign-in needed; no values of single customers.

type Kpi = 'deadlineAdherence' | 'cycleTimeDays' | 'realizationRate' | 'aiCorrectionRate';
interface Figure {
  value: number;
  unit: 'percent' | 'days';
  tenants: number;
}
interface BenchmarkData {
  minTenants: number;
  kpis: Kpi[];
  quarters: { quarter: string; from: string; to: string; tenants: number | null; published: boolean; figures: Record<Kpi, Figure | null> | null }[];
}

const value = (f: Figure) => t(f.unit === 'percent' ? 'insights.bench.percent' : 'insights.bench.days', { v: formatNumber(f.value) });

export function Benchmark() {
  const { data, error, loading } = useLoad<BenchmarkData>('/api/benchmark');
  useEffect(() => {
    document.title = t('insights.bench.title');
  }, []);
  return (
    <div className="landing">
      <header className="topbar">
        <Link to="/" className="brand">Ideenportal</Link>{/* texts-ok */}
        <div className="topbar-right">
          <LanguageSwitch />
          <Link to="/" className="button">{t('insights.bench.home')}</Link>
        </div>
      </header>
      <main id="inhalt" className="stack">
        <h1>{t('insights.bench.title')}</h1>
        <p className="lead">{t('insights.bench.intro', { n: data?.minTenants ?? 5 })}</p>
        <ErrorBox error={error} />
        {loading && !data && <Loading />}
        {data && data.quarters.length === 0 && <p className="muted">{t('insights.bench.none')}</p>}
        {data?.quarters.map((q) => (
          <section key={q.quarter} className="card stack" aria-labelledby={`bq-${q.quarter}`}>
            <h2 id={`bq-${q.quarter}`}>{t('insights.bench.quarter', { q: q.quarter })}</h2>
            <p className="small muted">
              {t('insights.bench.period', { from: formatDate(q.from), to: formatDate(q.to) })}
              {q.tenants ? ` · ${t('insights.bench.tenants', { n: q.tenants })}` : ''}
            </p>
            {!q.published || !q.figures ? (
              <p>{t('insights.bench.notEnough', { n: data.minTenants })}</p>
            ) : (
              <dl className="grid grid-2">
                {data.kpis.map((k) => {
                  const f = q.figures![k];
                  return (
                    <div key={k} className="card">
                      <dt><strong>{t(`insights.bench.kpi.${k}` as MessageKey)}</strong></dt>
                      <dd style={{ margin: 0 }}>
                        <span style={{ fontSize: '1.6em' }}>{f ? value(f) : t('insights.bench.noValue')}</span>
                        <br />
                        <span className="small muted">{t(`insights.bench.kpi.${k}.hint` as MessageKey)}</span>
                      </dd>
                    </div>
                  );
                })}
              </dl>
            )}
          </section>
        ))}
        <p className="small muted">{t('insights.bench.method', { n: data?.minTenants ?? 5 })}</p>
      </main>
    </div>
  );
}
