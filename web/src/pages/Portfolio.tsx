import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ErrorBox, Loading, StatusBadge, useLoad } from '../components';
import { HORIZON, formatEuro } from '../labels';
import { useSession } from '../session';
import { t } from '../i18n';
import { PortfolioAsk } from './PortfolioAsk';

// Portfolio board (R2-08): columns by phase, filters by horizon and topic, sums of plan and actual benefit.

interface PortfolioItem {
  id: string;
  number: number;
  title: string;
  status: string;
  topic: string | null;
  horizon: number | null;
  confidential: boolean;
  planBenefitEuro: number | null;
  actualBenefitEuro: number | null;
  mentorName: string | null;
}

interface PortfolioData {
  columns: { key: string; title: string; items: PortfolioItem[]; sums: { planBenefitEuro: number; actualBenefitEuro: number } }[];
  totals: { planBenefitEuro: number; actualBenefitEuro: number };
}

export function Portfolio() {
  const { settings } = useSession();
  const [horizon, setHorizon] = useState('');
  const [topic, setTopic] = useState('');
  const query = new URLSearchParams();
  if (horizon) query.set('horizon', horizon);
  if (topic) query.set('topic', topic);
  const { data, error, loading } = useLoad<PortfolioData>(`/api/portfolio?${query.toString()}`);
  return (
    <div className="stack">
      <h1>{t('portfolio.title')}</h1>
      <p className="small" style={{ margin: 0 }}><Link to="/kalibrierung">{t('learning.calibration.link')}</Link></p>
      <PortfolioAsk />
      <div className="card row" role="search" aria-label={t('portfolio.filter')}>
        <div>
          <label htmlFor="pf-horizon">{t('portfolio.horizon')}</label>
          <select id="pf-horizon" value={horizon} onChange={(e) => setHorizon(e.target.value)}>
            <option value="">{t('portfolio.all')}</option>
            {[1, 2, 3].map((h) => <option key={h} value={h}>{HORIZON[h]}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="pf-topic">{t('portfolio.topic')}</label>
          <select id="pf-topic" value={topic} onChange={(e) => setTopic(e.target.value)}>
            <option value="">{t('portfolio.all')}</option>
            {settings.topics.map((tp) => <option key={tp}>{tp}</option>)}
          </select>
        </div>
        {data && (
          <p className="small" style={{ alignSelf: 'flex-end', margin: 0 }} aria-live="polite">
            {t('portfolio.totalPlan')} <strong>{formatEuro(data.totals.planBenefitEuro)}</strong> · {t('portfolio.actual')} <strong>{formatEuro(data.totals.actualBenefitEuro)}</strong>
          </p>
        )}
      </div>
      <p className="small muted">{t('portfolio.note')}</p>
      <ErrorBox error={error} />
      {loading && !data ? <Loading /> : data && (
        <div className="board">
          {data.columns.map((col) => (
            <section key={col.key} className="board-col" aria-labelledby={`pf-${col.key}`}>
              <h2 id={`pf-${col.key}`}>
                {col.title} <span className="badge">{col.items.length}</span>
              </h2>
              <p className="small" style={{ margin: '0 0 8px' }}>
                {t('portfolio.plan', { value: formatEuro(col.sums.planBenefitEuro) })}<br />{t('portfolio.actualShort', { value: formatEuro(col.sums.actualBenefitEuro) })}
              </p>
              {col.items.map((i) => (
                <Link key={i.id} className="board-card" to={`/ideen/${i.id}`}>
                  <div className="small muted">#{i.number} · {i.topic ?? t('portfolio.noTopic')}{i.horizon ? ` · H${i.horizon}` : ''}</div>
                  <strong>{i.title}</strong>
                  <div className="row small" style={{ marginTop: 6 }}>
                    <StatusBadge status={i.status} />
                    {i.confidential && <span className="badge">{t('portfolio.confidential')}</span>}
                    {i.planBenefitEuro != null && <span>{t('portfolio.plan', { value: formatEuro(i.planBenefitEuro) })}</span>}
                    {i.actualBenefitEuro != null && <span>{t('portfolio.actualShort', { value: formatEuro(i.actualBenefitEuro) })}</span>}
                  </div>
                </Link>
              ))}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
