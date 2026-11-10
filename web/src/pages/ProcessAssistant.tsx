import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { ErrorBox, Field, Loading, useAction, useLoad } from '../components';
import { formatEuro, labelMap, t } from '../i18n';
import { useSession } from '../session';

// AI proposal for the process (R3-03): the admin describes the process; the AI proposes lanes,
// thresholds, deadlines and scorecard weights. Nothing changes until the admin takes the
// proposal over; afterwards every value stays editable under Settings › Process.

type Template = 'innovation' | 'product';
const TEMPLATE_LABELS = labelMap('billing.process.template', ['innovation', 'product'] as const);
const LANE_LABELS = labelMap('billing.process.lane', ['fast_lane', 'elaborate', 'forward', 'reject'] as const);

interface Proposal {
  thresholds: { fastLaneMaxPersonDays: number; fastLaneMaxEuro: number; delegationMaxPersonDays: number; delegationMaxEuro: number };
  deadlines: { gate1Workdays: number; elaborationWorkdays: number };
  weights: { id: string; weight: number; reason: string }[];
  lanes: { lane: 'fast_lane' | 'elaborate' | 'forward' | 'reject'; rule: string }[];
  rationale: string[];
}

interface Shown {
  proposal: Proposal;
  source: 'ai' | 'template';
  template: Template | null;
  resultId: string | null;
  builtin: boolean;
  model: string | null;
  warnings: string[];
}

interface CurrentSettings {
  thresholds: Proposal['thresholds'];
  deadlines: { gate1Workdays: number; elaborationWorkdays: number };
  scorecard: { criteria: { id: string; label: string; weight: number }[] };
}

export function ProcessAssistant() {
  const { refresh } = useSession();
  const settings = useLoad<CurrentSettings>('/api/admin/settings');
  const templates = useLoad<{ id: Template; proposal: Proposal }[]>('/api/admin/process-templates');
  const [form, setForm] = useState({ template: 'innovation' as Template, employees: '', ideasPerYear: '', reviewers: '', committee: true, fastLaneBudgetEur: '', description: '' });
  const [shown, setShown] = useState<Shown | null>(null);
  const [applied, setApplied] = useState(false);
  const ask = useAction();
  const take = useAction();
  const num = (v: string) => (v.trim() === '' ? null : Number(v));

  const propose = async (e: FormEvent) => {
    e.preventDefault();
    setApplied(false);
    const r = await ask.run(() => api.post<{ proposal: Proposal; resultId: string; builtin: boolean; model: string; warnings: string[] }>('/api/admin/process-proposal', {
      template: form.template, employees: num(form.employees), ideasPerYear: num(form.ideasPerYear), reviewers: num(form.reviewers),
      committee: form.committee, fastLaneBudgetEur: num(form.fastLaneBudgetEur), description: form.description,
    }));
    if (r) setShown({ proposal: r.proposal, source: 'ai', template: null, resultId: r.resultId, builtin: r.builtin, model: r.model, warnings: r.warnings });
  };

  const showTemplate = (id: Template) => {
    const tpl = templates.data?.find((x) => x.id === id);
    if (!tpl) return;
    setApplied(false);
    setShown({ proposal: tpl.proposal, source: 'template', template: id, resultId: null, builtin: true, model: null, warnings: [] });
  };

  const apply = async () => {
    if (!shown) return;
    const r = await take.run(() => api.post('/api/admin/process-proposal/apply', { proposal: shown.proposal, source: shown.source, resultId: shown.resultId, template: shown.template }));
    if (r) {
      setApplied(true);
      setShown(null);
      await settings.reload();
      await refresh();
    }
  };

  if (settings.loading && !settings.data) return <Loading />;
  const current = settings.data;
  const label = (id: string) => current?.scorecard.criteria.find((c) => c.id === id)?.label ?? id;

  return (
    <div className="stack">
      <form className="card" onSubmit={propose} aria-labelledby="h-process-ai">
        <h2 id="h-process-ai" style={{ marginTop: 0 }}>{t('billing.process.heading')}</h2>
        <p className="small muted">{t('billing.process.intro')}</p>
        <ErrorBox error={ask.error} />
        {applied && <div className="alert success" role="status">{t('billing.process.applied')}</div>}
        <fieldset>
          <legend>{t('billing.process.templateLegend')}</legend>
          {(['innovation', 'product'] as const).map((id) => (
            <label key={id} className="check">
              <input type="radio" name="process-template" checked={form.template === id} onChange={() => setForm({ ...form, template: id })} /> {TEMPLATE_LABELS[id]}
            </label>
          ))}
        </fieldset>
        <div className="grid grid-3">
          <Field id="pa-employees" label={t('billing.process.employees')}>
            <input id="pa-employees" type="number" min={1} value={form.employees} onChange={(e) => setForm({ ...form, employees: e.target.value })} />
          </Field>
          <Field id="pa-ideas" label={t('billing.process.ideasPerYear')}>
            <input id="pa-ideas" type="number" min={0} value={form.ideasPerYear} onChange={(e) => setForm({ ...form, ideasPerYear: e.target.value })} />
          </Field>
          <Field id="pa-reviewers" label={t('billing.process.reviewers')}>
            <input id="pa-reviewers" type="number" min={1} value={form.reviewers} onChange={(e) => setForm({ ...form, reviewers: e.target.value })} />
          </Field>
          <Field id="pa-budget" label={t('billing.process.budget')}>
            <input id="pa-budget" type="number" min={0} value={form.fastLaneBudgetEur} onChange={(e) => setForm({ ...form, fastLaneBudgetEur: e.target.value })} />
          </Field>
        </div>
        <label className="check">
          <input type="checkbox" checked={form.committee} onChange={(e) => setForm({ ...form, committee: e.target.checked })} /> {t('billing.process.committee')}
        </label>
        <Field id="pa-description" label={t('billing.process.description')} hint={t('billing.process.descriptionHint')}>
          <textarea id="pa-description" rows={5} maxLength={3000} value={form.description} aria-describedby="pa-description-hint" onChange={(e) => setForm({ ...form, description: e.target.value })} />
        </Field>
        <div className="row">
          <button type="submit" className="primary" disabled={ask.busy}>{ask.busy ? t('billing.process.working') : t('billing.process.propose')}</button>
          {(['innovation', 'product'] as const).map((id) => (
            <button key={id} type="button" onClick={() => showTemplate(id)} disabled={!templates.data}>{t('billing.process.useTemplate', { template: TEMPLATE_LABELS[id] })}</button>
          ))}
        </div>
      </form>

      {shown && current && (
        <section className="card" aria-labelledby="h-proposal">
          <h2 id="h-proposal" style={{ marginTop: 0 }}>
            {shown.source === 'ai' ? t('billing.process.proposalAi') : t('billing.process.proposalTemplate', { template: TEMPLATE_LABELS[shown.template ?? 'innovation'] })}
          </h2>
          {shown.source === 'ai' && (
            <p className="small"><span className="badge accent">{t('billing.process.aiBadge')}</span> {shown.builtin ? t('billing.process.builtin') : t('billing.process.model', { model: shown.model ?? '' })}</p>
          )}
          {shown.warnings.map((w) => <div key={w} className="alert warn">{w}</div>)}
          <p className="small muted">{t('billing.process.estimates')}</p>
          <div className="table-wrap" tabIndex={0}>
            <table>
              <caption className="sr-only">{t('billing.process.compare')}</caption>
              <thead>
                <tr><th scope="col">{t('billing.process.value')}</th><th scope="col">{t('billing.process.now')}</th><th scope="col">{t('billing.process.proposed')}</th></tr>
              </thead>
              <tbody>
                <tr><th scope="row">{t('billing.process.fastDays')}</th><td>{current.thresholds.fastLaneMaxPersonDays}</td><td>{shown.proposal.thresholds.fastLaneMaxPersonDays}</td></tr>
                <tr><th scope="row">{t('billing.process.fastEuro')}</th><td>{formatEuro(current.thresholds.fastLaneMaxEuro)}</td><td>{formatEuro(shown.proposal.thresholds.fastLaneMaxEuro)}</td></tr>
                <tr><th scope="row">{t('billing.process.delegationDays')}</th><td>{current.thresholds.delegationMaxPersonDays}</td><td>{shown.proposal.thresholds.delegationMaxPersonDays}</td></tr>
                <tr><th scope="row">{t('billing.process.delegationEuro')}</th><td>{formatEuro(current.thresholds.delegationMaxEuro)}</td><td>{formatEuro(shown.proposal.thresholds.delegationMaxEuro)}</td></tr>
                <tr><th scope="row">{t('billing.process.gate1')}</th><td>{current.deadlines.gate1Workdays}</td><td>{shown.proposal.deadlines.gate1Workdays}</td></tr>
                <tr><th scope="row">{t('billing.process.elaboration')}</th><td>{current.deadlines.elaborationWorkdays}</td><td>{shown.proposal.deadlines.elaborationWorkdays}</td></tr>
                {shown.proposal.weights.map((w) => (
                  <tr key={w.id}>
                    <th scope="row">{t('billing.process.weight', { criterion: label(w.id) })}</th>
                    <td>{current.scorecard.criteria.find((c) => c.id === w.id)?.weight ?? '–'} %</td>
                    <td>{w.weight} %{w.reason ? <span className="small muted"> · {w.reason}</span> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h3>{t('billing.process.lanes')}</h3>
          <ul>
            {shown.proposal.lanes.map((l) => <li key={l.lane}><strong>{LANE_LABELS[l.lane]}:</strong> {l.rule}</li>)}
          </ul>
          <h3>{t('billing.process.why')}</h3>
          <ul>{shown.proposal.rationale.map((r) => <li key={r}>{r}</li>)}</ul>
          <ErrorBox error={take.error} />
          <div className="row">
            <button type="button" className="primary" onClick={apply} disabled={take.busy}>{t('billing.process.apply')}</button>
            <button type="button" onClick={() => setShown(null)}>{t('billing.process.discard')}</button>
          </div>
          <p className="small muted" style={{ marginBottom: 0 }}>{t('billing.process.changeable')}</p>
        </section>
      )}
    </div>
  );
}
