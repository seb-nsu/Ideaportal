import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../api';
import { ErrorBox, Field, Loading, useAction, useLoad } from '../components';
import { intlLocale, labelMap, t } from '../i18n';

// Evaluation runs with comparison, regressions and report downloads (R2-12), plus the settings of
// the quality check and the server-side fallback model (Einstellungen › KI › Qualität).

interface Metric {
  score: number;
  minScore: number;
  passed: boolean;
  n: number;
  notes: string[];
  promptVersion?: string;
  model?: string;
  judged?: number;
}
interface AgentDelta {
  agent: string;
  score: number;
  previous: number | null;
  delta: number | null;
  passed: boolean;
  trend: 'new' | 'improved' | 'unchanged' | 'regressed';
  promptChanged: boolean;
  modelChanged: boolean;
}
interface Regression {
  kind: 'agent_failed' | 'agent_drop' | 'case_drop';
  agent: string;
  caseId?: string;
  before: number;
  after: number;
  delta: number;
}
interface Comparison {
  previousRunId: string | null;
  previousAt: string | null;
  tolerance: number;
  agents: AgentDelta[];
  regressions: Regression[];
}
interface Run {
  id: string;
  trigger: string;
  status: string;
  metrics: Record<string, Metric>;
  costEur: number;
  error: string | null;
  createdAt: string;
  testsetVersion: number | null;
  comparison: Comparison | null;
  names?: Record<string, string>;
}

export interface QualitySettings {
  evals: { sampleSize: number; regressionTolerance: number; judge: { enabled: boolean; weight: number; maxCostEurPerRun: number; maxCasesPerAgent: number } };
  fallback: { serverSide: boolean };
}

const TRIGGER = labelMap('aiAdmin.evalTrigger', ['manual', 'config_change', 'initial'] as const);
const STATUS = labelMap('aiAdmin.evalStatus', ['running', 'done', 'failed'] as const);
const TREND = labelMap('aiEvals.trend', ['new', 'improved', 'unchanged', 'regressed'] as const);
const dateTime = (value: string) => new Date(value).toLocaleString(intlLocale());
const pct = (n: number | null | undefined) => (n == null ? '–' : `${Math.round(n * 100)} %`);
const points = (n: number | null | undefined) => (n == null ? '–' : `${n > 0 ? '+' : ''}${Math.round(n * 100)}`);

function regressionText(r: Regression, name: string): string {
  const vars = { agent: name, case: r.caseId ?? '', before: pct(r.before), after: pct(r.after) };
  if (r.kind === 'agent_failed') return t('aiEvals.regression.agentFailed', vars);
  if (r.kind === 'agent_drop') return t('aiEvals.regression.agentDrop', vars);
  return t('aiEvals.regression.caseDrop', vars);
}

function RunDetails({ run }: { run: Run }) {
  const name = (a: string) => run.names?.[a] ?? a;
  const deltas = new Map((run.comparison?.agents ?? []).map((d) => [d.agent, d]));
  const entries = Object.entries(run.metrics ?? {});
  const passed = entries.filter(([, m]) => m.passed).length;
  const regressions = run.comparison?.regressions ?? [];
  return (
    <div className="stack">
      {run.error && <p className="alert error">{run.error}</p>}
      {run.status === 'done' && (
        <p className="small">
          {t('aiEvals.summary', { passed, n: entries.length })}
          {run.testsetVersion != null && <> · {t('aiEvals.testset', { version: run.testsetVersion })}</>}
          {run.comparison?.previousAt && <> · {t('aiEvals.comparedWith', { date: dateTime(run.comparison.previousAt) })}</>}
        </p>
      )}
      {regressions.length > 0 ? (
        <div className="alert warn" role="status">
          <strong>{t('aiEvals.regressions', { n: regressions.length })}</strong>
          <ul className="small">
            {regressions.slice(0, 10).map((r, i) => (
              <li key={i}>{regressionText(r, name(r.agent))}</li>
            ))}
          </ul>
        </div>
      ) : run.comparison?.previousRunId ? (
        <p className="small muted">{t('aiEvals.noRegressions')}</p>
      ) : null}
      {entries.length > 0 && (
        <div className="table-wrap" tabIndex={0}>
          <table>
            <caption className="sr-only">{t('aiEvals.tableCaption')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('aiEvals.col.agent')}</th>
                <th scope="col">{t('aiEvals.col.score')}</th>
                <th scope="col">{t('aiEvals.col.min')}</th>
                <th scope="col">{t('aiEvals.col.delta')}</th>
                <th scope="col">{t('aiEvals.col.cases')}</th>
                <th scope="col">{t('aiEvals.col.prompt')}</th>
                <th scope="col">{t('aiEvals.col.status')}</th>
              </tr>
            </thead>
            <tbody>
              {entries.map(([k, m]) => {
                const d = deltas.get(k);
                return (
                  <tr key={k}>
                    <td>{name(k)}</td>
                    <td>{pct(m.score)}</td>
                    <td>{pct(m.minScore)}</td>
                    <td>
                      {d ? (
                        <>
                          {points(d.delta)} <span className="small muted">({TREND[d.trend]})</span>
                        </>
                      ) : (
                        '–'
                      )}
                    </td>
                    <td>
                      {m.n}
                      {m.judged ? <span className="small muted"> · {t('aiEvals.judged', { n: m.judged })}</span> : null}
                    </td>
                    <td>
                      <code>{m.promptVersion ?? '–'}</code>
                      {d?.promptChanged && <span className="badge">{t('aiEvals.promptChanged')}</span>}
                      {d?.modelChanged && <span className="badge">{t('aiEvals.modelChanged')}</span>}
                    </td>
                    <td>
                      <span className={`badge ${m.passed ? 'green' : 'red'}`}>{m.passed ? t('aiAdmin.eval.passed') : t('aiAdmin.eval.failed')}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {run.status === 'done' && (
        <div className="row">
          <a className="button" href={`/api/admin/ai/evals/${run.id}/report.md`} download>
            {t('aiEvals.downloadMd')}
          </a>
          <a className="button" href={`/api/admin/ai/evals/${run.id}/report.json`} download>
            {t('aiEvals.downloadJson')}
          </a>
        </div>
      )}
    </div>
  );
}

/** Evaluation runs with delta, regressions and downloads. Lives inside the settings form, so no own form. */
export function EvalReports() {
  const { data, reload } = useLoad<Run[]>('/api/admin/ai/evals');
  const start = useAction();
  const running = data?.some((r) => r.status === 'running');
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void reload(), 5000);
    return () => clearInterval(timer);
  }, [running, reload]);
  return (
    <div className="stack">
      <div className="row">
        <button
          type="button"
          onClick={async () => {
            await start.run(() => api.post('/api/admin/ai/eval'));
            setTimeout(() => void reload(), 1500);
          }}
          disabled={start.busy}
        >
          {t('aiAdmin.eval.start')}
        </button>
        <span className="small muted">{t('aiAdmin.eval.hint')}</span>
      </div>
      <ErrorBox error={start.error} />
      {data?.slice(0, 5).map((r, i) => (
        <details key={r.id} open={i === 0}>
          <summary>
            {dateTime(r.createdAt)} · {TRIGGER[r.trigger]} · {STATUS[r.status]}
            {r.costEur ? ` · ${Number(r.costEur).toFixed(2)} €` : ''}
            {(r.comparison?.regressions.length ?? 0) > 0 && (
              <>
                {' '}
                · <span className="badge red">{t('aiEvals.regressionsShort', { n: r.comparison!.regressions.length })}</span>
              </>
            )}
          </summary>
          <RunDetails run={r} />
        </details>
      ))}
    </div>
  );
}

/** Settings of the quality check and the fallback model (own form, outside the settings form). */
export function EvalSettings({ onSaved }: { onSaved: (q: QualitySettings) => void }) {
  const { data, loading } = useLoad<QualitySettings>('/api/admin/ai/quality-settings');
  const [q, setQ] = useState<QualitySettings | null>(null);
  const [saved, setSaved] = useState(false);
  const save = useAction();
  useEffect(() => {
    if (data) setQ(data);
  }, [data]);
  if (loading && !q) return <Loading />;
  if (!q) return null;
  const judge = (patch: Partial<QualitySettings['evals']['judge']>) => setQ({ ...q, evals: { ...q.evals, judge: { ...q.evals.judge, ...patch } } });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaved(false);
    if (await save.run(() => api.put('/api/admin/ai/quality-settings', q))) {
      setSaved(true);
      onSaved(q);
    }
  };
  return (
    <section className="card" aria-labelledby="h-eval-settings">
      <h3 id="h-eval-settings">{t('aiEvals.settings.title')}</h3>
      <form className="stack" onSubmit={submit}>
        <fieldset>
          <legend>{t('aiEvals.settings.testset')}</legend>
          <Field id="ev-sample" label={t('aiEvals.settings.sampleSize')} hint={t('aiEvals.settings.sampleSizeHint')}>
            <input
              id="ev-sample"
              type="number"
              min={3}
              max={100}
              value={q.evals.sampleSize}
              onChange={(e) => setQ({ ...q, evals: { ...q.evals, sampleSize: Number(e.target.value) } })}
            />
          </Field>
          <Field id="ev-tol" label={t('aiEvals.settings.tolerance')} hint={t('aiEvals.settings.toleranceHint')}>
            <input
              id="ev-tol"
              type="number"
              min={0}
              max={100}
              value={Math.round(q.evals.regressionTolerance * 100)}
              onChange={(e) => setQ({ ...q, evals: { ...q.evals, regressionTolerance: Number(e.target.value) / 100 } })}
            />
          </Field>
        </fieldset>
        <fieldset>
          <legend>{t('aiEvals.settings.judge')}</legend>
          <p className="small muted">{t('aiEvals.settings.judgeHint')}</p>
          <label className="check">
            <input type="checkbox" checked={q.evals.judge.enabled} onChange={(e) => judge({ enabled: e.target.checked })} />{' '}
            {t('aiEvals.settings.judgeEnabled')}
          </label>
          <Field id="ev-weight" label={t('aiEvals.settings.judgeWeight')}>
            <input
              id="ev-weight"
              type="number"
              min={0}
              max={100}
              value={Math.round(q.evals.judge.weight * 100)}
              onChange={(e) => judge({ weight: Number(e.target.value) / 100 })}
              disabled={!q.evals.judge.enabled}
            />
          </Field>
          <Field id="ev-cost" label={t('aiEvals.settings.judgeCost')}>
            <input
              id="ev-cost"
              type="number"
              min={0}
              max={1000}
              step={0.5}
              value={q.evals.judge.maxCostEurPerRun}
              onChange={(e) => judge({ maxCostEurPerRun: Number(e.target.value) })}
              disabled={!q.evals.judge.enabled}
            />
          </Field>
          <Field id="ev-cases" label={t('aiEvals.settings.judgeCases')}>
            <input
              id="ev-cases"
              type="number"
              min={1}
              max={100}
              value={q.evals.judge.maxCasesPerAgent}
              onChange={(e) => judge({ maxCasesPerAgent: Number(e.target.value) })}
              disabled={!q.evals.judge.enabled}
            />
          </Field>
        </fieldset>
        <fieldset>
          <legend>{t('aiEvals.settings.fallback')}</legend>
          <label className="check">
            <input type="checkbox" checked={q.fallback.serverSide} onChange={(e) => setQ({ ...q, fallback: { serverSide: e.target.checked } })} />{' '}
            {t('aiEvals.settings.fallbackEnabled')}
          </label>
          <p className="small muted">{t('aiEvals.settings.fallbackHint')}</p>
        </fieldset>
        <ErrorBox error={save.error} />
        {saved && (
          <div className="alert info" role="status">
            {t('aiEvals.settings.saved')}
          </div>
        )}
        <div>
          <button className="primary" disabled={save.busy}>
            {t('aiEvals.settings.save')}
          </button>
        </div>
      </form>
    </section>
  );
}
