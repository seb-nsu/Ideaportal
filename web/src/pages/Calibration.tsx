import { Link } from 'react-router-dom';
import { ErrorBox, Loading, useLoad } from '../components';
import { formatEuro, formatNumber } from '../labels';
import { labelMap, t } from '../i18n';

// Calibration of forecasts (R4-07): deviation report per quarter and correction factors per
// idea type and kind. Aggregated only; from 20 closed ideas on.

interface Quarter {
  quarter: string;
  n: number;
  enough: boolean;
  plan?: number;
  actual?: number;
  deviationPercent?: number;
  hitRate?: number;
}

interface Factor {
  ideaType: 'internal' | 'product';
  ideaKind: 'idea' | 'problem' | null;
  n: number;
  enough: boolean;
  factor?: number;
  hitRate?: number;
  effortFactor?: number | null;
}

interface Report {
  closed: number;
  minClosed: number;
  minGroup: number;
  tolerancePercent: number;
  enough: boolean;
  overall?: { factor: number; low: number; high: number; hitRate: number };
  quarters?: Quarter[];
  factors?: Factor[];
}

const TYPE = labelMap('learning.calibration.type', ['internal', 'product'] as const);
const KIND = labelMap('learning.calibration.kind', ['idea', 'problem'] as const);
const pct = (x: number) => formatNumber(Math.round(x * 100));

export function Calibration() {
  const { data, error, loading } = useLoad<Report>('/api/calibration');
  return (
    <div className="stack">
      <p className="muted small" style={{ margin: 0 }}><Link to="/portfolio">{t('app.nav.portfolio')}</Link></p>
      <h1>{t('learning.calibration.title')}</h1>
      <p className="muted">{t('learning.calibration.intro')}</p>
      <ErrorBox error={error} />
      {loading && !data ? <Loading /> : data && !data.enough ? (
        <p className="card muted">{t('learning.calibration.notEnough', { min: data.minClosed, n: data.closed })}</p>
      ) : data?.overall && (
        <>
          <p className="card">
            {t('learning.calibration.overall', {
              factor: pct(data.overall.factor), low: pct(data.overall.low), high: pct(data.overall.high), hit: pct(data.overall.hitRate), tol: data.tolerancePercent,
            })}
          </p>
          <section className="card" aria-labelledby="h-cal-quarters">
            <h2 id="h-cal-quarters">{t('learning.calibration.quarters')}</h2>
            <div className="table-wrap" tabIndex={0}><table>
              <thead>
                <tr>
                  <th scope="col">{t('learning.calibration.col.quarter')}</th>
                  <th scope="col">{t('learning.calibration.col.n')}</th>
                  <th scope="col">{t('learning.calibration.col.plan')}</th>
                  <th scope="col">{t('learning.calibration.col.actual')}</th>
                  <th scope="col">{t('learning.calibration.col.deviation')}</th>
                  <th scope="col">{t('learning.calibration.col.hit')}</th>
                </tr>
              </thead>
              <tbody>
                {data.quarters!.map((q) => (
                  <tr key={q.quarter}>
                    <th scope="row">{q.quarter}</th>
                    <td>{q.n}</td>
                    {q.enough ? (
                      <>
                        <td>{formatEuro(q.plan)}</td>
                        <td>{formatEuro(q.actual)}</td>
                        <td>{q.deviationPercent! > 0 ? '+' : ''}{formatNumber(q.deviationPercent)} %</td>
                        <td>{pct(q.hitRate!)} %</td>
                      </>
                    ) : <td colSpan={4} className="muted">{t('learning.calibration.tooFew', { min: data.minGroup })}</td>}
                  </tr>
                ))}
              </tbody>
            </table></div>
          </section>
          <section className="card" aria-labelledby="h-cal-factors">
            <h2 id="h-cal-factors">{t('learning.calibration.factors')}</h2>
            <p className="muted small">{t('learning.calibration.factorsIntro')}</p>
            <div className="table-wrap" tabIndex={0}><table>
              <thead>
                <tr>
                  <th scope="col">{t('learning.calibration.col.type')}</th>
                  <th scope="col">{t('learning.calibration.col.kind')}</th>
                  <th scope="col">{t('learning.calibration.col.n')}</th>
                  <th scope="col">{t('learning.calibration.col.factor')}</th>
                  <th scope="col">{t('learning.calibration.col.hit')}</th>
                  <th scope="col">{t('learning.calibration.col.effort')}</th>
                </tr>
              </thead>
              <tbody>
                {data.factors!.map((f) => (
                  <tr key={`${f.ideaType}-${f.ideaKind ?? 'all'}`}>
                    <th scope="row">{TYPE[f.ideaType]}</th>
                    <td>{f.ideaKind ? KIND[f.ideaKind] : t('learning.calibration.allKinds')}</td>
                    <td>{f.n}</td>
                    {f.enough ? (
                      <>
                        <td>{formatNumber(f.factor)}</td>
                        <td>{pct(f.hitRate!)} %</td>
                        <td>{f.effortFactor != null ? formatNumber(f.effortFactor) : '–'}</td>
                      </>
                    ) : <td colSpan={3} className="muted">{t('learning.calibration.tooFew', { min: data.minGroup })}</td>}
                  </tr>
                ))}
              </tbody>
            </table></div>
          </section>
        </>
      )}
    </div>
  );
}
