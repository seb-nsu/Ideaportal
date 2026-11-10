import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { ErrorBox, Field, StatusBadge, useAction } from '../components';
import { STATUS_SHORT, formatDate, formatEuro } from '../labels';
import { t } from '../i18n';

// Questions to the portfolio in everyday language (R3-23): the AI (or the rule-based reading)
// turns the question into a filter; the list comes from the portfolio with the person's read rights.

interface Filter {
  statuses: string[];
  topics: string[];
  ideaType: 'internal' | 'product' | null;
  challenge: string | null;
  submittedFrom: string | null;
  submittedTo: string | null;
  planBenefitMin: number | null;
  planBenefitMax: number | null;
  actualBenefitMin: number | null;
  actualBenefitMax: number | null;
  text: string | null;
  sort: 'newest' | 'oldest' | 'updated' | 'plan_benefit' | 'actual_benefit';
  limit: number;
}

interface Answer {
  filter: Filter;
  items: {
    id: string; number: number; title: string; status: string; topic: string | null; confidential: boolean;
    submittedAt: string | null; planBenefitEuro: number | null; actualBenefitEuro: number | null; url: string;
  }[];
  total: number;
  summary: string;
  ai: { builtin: boolean; model: string };
}

function chips(f: Filter): string[] {
  const out: string[] = [];
  if (f.statuses.length) out.push(t('insights.ask.chip.status', { list: f.statuses.map((s) => STATUS_SHORT[s] ?? s).join(', ') }));
  if (f.topics.length) out.push(t('insights.ask.chip.topics', { list: f.topics.join(', ') }));
  if (f.ideaType) out.push(t(f.ideaType === 'internal' ? 'insights.ask.chip.type.internal' : 'insights.ask.chip.type.product'));
  if (f.challenge) out.push(t('insights.ask.chip.challenge', { title: f.challenge }));
  if (f.submittedFrom) out.push(t('insights.ask.chip.from', { date: formatDate(f.submittedFrom) }));
  if (f.submittedTo) out.push(t('insights.ask.chip.to', { date: formatDate(f.submittedTo) }));
  if (f.planBenefitMin != null) out.push(t('insights.ask.chip.planMin', { value: formatEuro(f.planBenefitMin) }));
  if (f.planBenefitMax != null) out.push(t('insights.ask.chip.planMax', { value: formatEuro(f.planBenefitMax) }));
  if (f.actualBenefitMin != null) out.push(t('insights.ask.chip.actualMin', { value: formatEuro(f.actualBenefitMin) }));
  if (f.actualBenefitMax != null) out.push(t('insights.ask.chip.actualMax', { value: formatEuro(f.actualBenefitMax) }));
  if (f.text) out.push(t('insights.ask.chip.text', { text: f.text }));
  if (!out.length) out.push(t('insights.ask.noFilter'));
  out.push(t(`insights.ask.sort.${f.sort}`));
  out.push(t('insights.ask.chip.limit', { n: f.limit }));
  return out;
}

export function PortfolioAsk() {
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<Answer | null>(null);
  const { busy, error, run } = useAction();
  const ask = async (e: FormEvent) => {
    e.preventDefault();
    const r = await run(() => api.post<Answer>('/api/portfolio/ask', { question }));
    if (r) setAnswer(r);
  };
  return (
    <section className="card stack" aria-labelledby="pf-ask">
      <h2 id="pf-ask">{t('insights.ask.title')}</h2>
      <form onSubmit={ask} className="stack">
        <Field id="pf-question" label={t('insights.ask.label')} hint={t('insights.ask.hint')}>
          <input id="pf-question" type="text" value={question} maxLength={500} placeholder={t('insights.ask.placeholder')}
            onChange={(e) => setQuestion(e.target.value)} aria-describedby="pf-question-hint" />
        </Field>
        <div className="row">
          <button className="primary" disabled={busy || question.trim().length < 3}>{busy ? t('insights.ask.busy') : t('insights.ask.submit')}</button>
        </div>
      </form>
      <ErrorBox error={error} />
      {answer && (
        <div className="stack" aria-live="polite">
          <h3>{t('insights.ask.results')}</h3>
          <p>{answer.summary}</p>
          <div className="small">
            <span className="muted">{t('insights.ask.understood')}</span>{' '}
            {chips(answer.filter).map((c) => <span key={c} className="badge" style={{ marginRight: 4 }}>{c}</span>)}
          </div>
          <p className="small muted">{answer.ai.builtin ? t('insights.ask.builtin') : t('insights.ask.ai', { model: answer.ai.model })}</p>
          {answer.items.length > 0 && (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th scope="col">{t('insights.ask.col.idea')}</th>
                    <th scope="col">{t('insights.ask.col.status')}</th>
                    <th scope="col">{t('insights.ask.col.topic')}</th>
                    <th scope="col">{t('insights.ask.col.submitted')}</th>
                    <th scope="col">{t('insights.ask.col.plan')}</th>
                    <th scope="col">{t('insights.ask.col.actual')}</th>
                  </tr>
                </thead>
                <tbody>
                  {answer.items.map((i) => (
                    <tr key={i.id}>
                      <td>
                        <Link to={i.url}>#{i.number} {i.title}</Link>
                        {i.confidential && <> <span className="badge">{t('insights.ask.confidential')}</span></>}
                      </td>
                      <td><StatusBadge status={i.status} /></td>
                      <td>{i.topic ?? '–'}</td>
                      <td>{formatDate(i.submittedAt)}</td>
                      <td>{formatEuro(i.planBenefitEuro)}</td>
                      <td>{formatEuro(i.actualBenefitEuro)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
