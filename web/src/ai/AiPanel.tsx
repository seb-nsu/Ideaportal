import { useEffect, useState, type FormEvent, type SyntheticEvent } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { Dialog, ErrorBox, Field, Loading, useAction, useLoad } from '../components';
import { formatDate, formatNumber, intlLocale, labelMap, t } from '../i18n';

// AI analyses of an idea (R2-11, R2-15, R2-18, R2-22 … R2-32): every statement is labelled,
// sources have a retrieval date, people correct single statements and adopt drafts by click.

export interface Claim {
  id: string;
  text: string;
  kind: 'fact' | 'assumption' | 'estimate';
  sources: number[];
  confidence: 'low' | 'medium' | 'high' | null;
  note?: string;
  correction?: { action: 'correct' | 'discard'; text: string | null; reason: string; by: string | null; at: string };
  /** Source check (R2-46): statement found in the text of a cited page, or not. */
  check?: 'confirmed' | 'not_found';
}
export interface Source {
  id: number; title: string; url: string; snippet: string; origin: 'web' | 'internal' | 'patent'; retrievedAt: string;
  check?: { reachable: boolean; status: number | null; quoteFound: boolean | null };
}
export type ReviewStatus = 'unchecked' | 'checked' | 'corrected';
export interface AiResult {
  id: string;
  kind: string;
  version: number;
  createdAt: string;
  edited: boolean;
  data: Record<string, any>;
  sections: { heading: string; claims: Claim[] }[];
  sources: Source[];
  warnings: string[];
  // uncheckedModel: a fallback model answered that has not passed the test set (R2-12).
  meta: { model: string; provider: string; local: boolean; generatedAt: string; costEur: number; uncheckedModel?: string; promptVersion?: string };
  changes: { added: string[]; removed: string[] } | null;
  computed: any;
  /** Review status (R2-44); null for results without one, e.g. the triage suggestion. */
  review?: { status: ReviewStatus; by: string | null; at: string | null } | null;
  myRating?: boolean | null;
  sample?: { id: string; month: string; verdict: 'correct' | 'minor' | 'wrong' | null; note: string | null } | null;
}
interface AiView {
  enabled: boolean;
  canWork: boolean;
  results: AiResult[];
  jobs: { kind: string; status: string; error: string | null; createdAt: string }[];
  budget: { spentEur: number; limitEur: number };
  modelConfigured: boolean;
  canConfigure: boolean;
  reviewRequired?: boolean;
}

export const KIND_LABEL = labelMap('aiPanel.kind', [
  'short_analysis', 'triage_suggestion', 'competition', 'patents', 'positioning', 'market_size', 'internal_market',
  'business_case', 'risk_check', 'experiment', 'counterarguments', 'dossier_draft', 'discussion_summary',
] as const);
const ORDER = Object.keys(KIND_LABEL);
export const CLAIM_LABEL = labelMap('aiPanel.claim', ['fact', 'assumption', 'estimate'] as const);
export const CLAIM_CLASS = { fact: 'green', assumption: 'yellow', estimate: 'accent' } as const;
export const CONF = labelMap('aiPanel.conf', ['low', 'medium', 'high'] as const);
const LANES = labelMap('aiPanel.lane', ['fast_lane', 'elaborate', 'forward', 'reject'] as const);
const JOB_LABEL = labelMap('aiPanel.job', ['short_analysis', 'full_analysis', 'eval_run'] as const);
const JOB_STATUS = labelMap('aiPanel.jobStatus', ['queued', 'running', 'done', 'failed', 'skipped'] as const);
export const REVIEW = labelMap('aiQuality.review', ['unchecked', 'checked', 'corrected'] as const);
export const REVIEW_CLASS: Record<ReviewStatus, string> = { unchecked: 'yellow', checked: 'green', corrected: 'accent' };
const VERDICT = labelMap('aiQuality.sample', ['correct', 'minor', 'wrong'] as const);
const DEFAULT_OPEN = ['short_analysis', 'triage_suggestion'];
const eur = (n: number | null | undefined) => (n == null ? '–' : `${formatNumber(Math.round(n))} €`);
const range = (r: { low: number; high: number } | null | undefined, unit = ' €') => (r ? t('aiPanel.range', { low: formatNumber(Math.round(r.low)), high: formatNumber(Math.round(r.high)), unit }) : '–');

/** Warnings without the unchecked-model notice, which has its own prominent alert. */
function shownWarnings(r: Pick<AiResult, 'warnings' | 'meta'>): string[] {
  const model = r.meta.uncheckedModel;
  return model ? r.warnings.filter((w) => !w.includes(model)) : r.warnings;
}

export function AiLabel({ meta }: { meta: AiResult['meta'] }) {
  return (
    <span className="badge accent" title={t('aiPanel.label.title', { model: meta.model, provider: meta.provider, date: new Date(meta.generatedAt).toLocaleString(intlLocale()) })}>
      {meta.provider === 'builtin' ? t('aiPanel.label.draftBuiltin') : t('aiPanel.label.draft')}
    </span>
  );
}

export function SourceList({ sources }: { sources: Source[] }) {
  if (!sources.length) return null;
  return (
    <details className="small">
      <summary>{t('aiPanel.sources.summary', { n: sources.length })}</summary>
      <ol className="ai-sources">
        {sources.map((s) => (
          <li key={s.id} id={`src-${s.id}`} value={s.id}>
            {s.origin === 'internal' ? <Link to={s.url}>{s.title}</Link> : <a href={s.url} target="_blank" rel="noreferrer noopener">{s.title}</a>}
            {s.origin === 'patent' && <span className="badge">{t('aiPanel.sources.patent')}</span>} <span className="muted">{t('aiPanel.sources.retrieved', { date: formatDate(s.retrievedAt) })}</span>
            {s.check && !s.check.reachable && <> <span className="badge red">{t('aiQuality.source.unreachable')}</span></>}
            {s.check?.reachable && s.check.quoteFound === true && <> <span className="badge green">{t('aiQuality.source.quoteFound')}</span></>}
            {s.check?.reachable && s.check.quoteFound === false && <> <span className="badge yellow">{t('aiQuality.source.quoteMissing')}</span></>}
          </li>
        ))}
      </ol>
    </details>
  );
}

function ClaimItem({ claim, sources, canWork, onCorrect }: { claim: Claim; sources: Source[]; canWork: boolean; onCorrect: (c: Claim) => void }) {
  const c = claim.correction;
  const discarded = c?.action === 'discard';
  return (
    <li className={`ai-claim${discarded ? ' discarded' : ''}`}>
      <span className={`badge ${CLAIM_CLASS[claim.kind]}`}>{CLAIM_LABEL[claim.kind]}</span>{' '}
      {c?.action === 'correct' ? (
        <>
          <span>{c.text}</span> <span className="muted small">({t('aiPanel.claimItem.correctedBefore')} <s>{claim.text}</s>)</span>
        </>
      ) : discarded ? (
        <><s>{claim.text}</s> <span className="muted small">{t('aiPanel.claimItem.discarded')}</span></>
      ) : (
        <span>{claim.text}</span>
      )}
      {claim.kind === 'estimate' && claim.confidence && <span className="muted small"> · {CONF[claim.confidence]}</span>}
      {claim.sources.map((id) => {
        const s = sources.find((x) => x.id === id);
        return s ? <a key={id} className="small ai-ref" href={`#src-${id}`} title={s.title}>[{id}]</a> : null;
      })}
      {claim.check === 'confirmed' && <> <span className="badge green small">{t('aiQuality.check.confirmed')}</span></>}
      {claim.check === 'not_found' && <> <span className="badge yellow small">{t('aiQuality.check.notFound')}</span></>}
      {claim.note && <span className="muted small"> · {claim.note}</span>}
      {c && <span className="muted small"> · {t('aiPanel.claimItem.reason', { reason: c.reason })}{c.by ? ` (${c.by})` : ''}</span>}
      {canWork && !c && (
        <>
          {' '}
          <button type="button" className="link small" onClick={() => onCorrect(claim)}>{t('aiPanel.claimItem.correct')}</button>
        </>
      )}
    </li>
  );
}

function Sections({ result, canWork, onCorrect }: { result: AiResult; canWork: boolean; onCorrect: (c: Claim) => void }) {
  return (
    <>
      {result.sections.map((s) => (
        <div key={s.heading}>
          <h4>{s.heading}</h4>
          <ul className="ai-claims">
            {s.claims.map((c) => <ClaimItem key={c.id} claim={c} sources={result.sources} canWork={canWork} onCorrect={onCorrect} />)}
          </ul>
        </div>
      ))}
    </>
  );
}

function CorrectionDialog({ resultId, claim, onClose, onDone }: { resultId: string; claim: Claim; onClose: () => void; onDone: () => void }) {
  const [action, setAction] = useState<'correct' | 'discard'>('correct');
  const [text, setText] = useState(claim.text);
  const [reason, setReason] = useState('');
  const { busy, error, run } = useAction();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (await run(() => api.post(`/api/ai/results/${resultId}/corrections`, { claimId: claim.id, action, correctedText: action === 'correct' ? text : undefined, reason }))) onDone();
  };
  return (
    <Dialog title={t('aiPanel.correction.title')} onClose={onClose}>
      <form onSubmit={submit}>
        <ErrorBox error={error} />
        <p className="small muted">{claim.text}</p>
        <fieldset>
          <legend>{t('aiPanel.correction.legend')}</legend>
          <label className="check"><input type="radio" name="act" checked={action === 'correct'} onChange={() => setAction('correct')} /> {t('aiPanel.correction.actionCorrect')}</label>
          <label className="check"><input type="radio" name="act" checked={action === 'discard'} onChange={() => setAction('discard')} /> {t('aiPanel.correction.actionDiscard')}</label>
        </fieldset>
        {action === 'correct' && (
          <Field id="corr-text" label={t('aiPanel.correction.text')}>
            <textarea id="corr-text" value={text} onChange={(e) => setText(e.target.value)} rows={3} required />
          </Field>
        )}
        <Field id="corr-reason" label={t('aiPanel.correction.reason')} hint={t('aiPanel.correction.reasonHint')}>
          <input id="corr-reason" value={reason} onChange={(e) => setReason(e.target.value)} minLength={5} required />
        </Field>
        <div className="row">
          <button className="primary" disabled={busy}>{t('aiPanel.save')}</button>
          <button type="button" onClick={onClose}>{t('aiPanel.cancel')}</button>
        </div>
      </form>
    </Dialog>
  );
}

function BusinessCase({ result, canWork, onSaved }: { result: AiResult; canWork: boolean; onSaved: () => void }) {
  const [items, setItems] = useState<any[]>(result.data.assumptions);
  const [years, setYears] = useState<number>(result.data.horizonYears ?? 3);
  const [computed, setComputed] = useState<any>(result.computed);
  const { busy, error, run } = useAction();
  useEffect(() => {
    setItems(result.data.assumptions);
    setComputed(result.computed);
  }, [result]);
  const KIND = labelMap('aiPanel.bc.kind', ['benefit', 'one_off_cost', 'running_cost'] as const);
  const SC = labelMap('aiPanel.bc.scenario', ['pessimistic', 'base', 'optimistic'] as const);
  const set = (i: number, k: 'low' | 'base' | 'high', v: string) => setItems((xs) => xs.map((x, n) => (n === i ? { ...x, [k]: v === '' ? null : Number(v) } : x)));
  const recalc = async () => {
    const res = await run(() => api.put<{ computed: any }>(`/api/ai/results/${result.id}/business-case`, { horizonYears: years, assumptions: items }));
    if (res) {
      setComputed(res.computed);
      onSaved();
    }
  };
  return (
    <div className="stack">
      <ErrorBox error={error} />
      <div className="table-wrap" tabIndex={0}>
        <table>
          <caption className="sr-only">{t('aiPanel.bc.assumptionsCaption')}</caption>
          <thead><tr><th scope="col">{t('aiPanel.bc.colAssumption')}</th><th scope="col">{t('aiPanel.bc.colKind')}</th><th scope="col">{t('aiPanel.bc.colLow')}</th><th scope="col">{t('aiPanel.bc.colBase')}</th><th scope="col">{t('aiPanel.bc.colHigh')}</th></tr></thead>
          <tbody>
            {items.map((a, i) => (
              <tr key={a.id}>
                <th scope="row">{a.label} <span className="badge accent">{t('aiPanel.claim.estimate')}</span></th>
                <td>{KIND[a.kind]}</td>
                {(['low', 'base', 'high'] as const).map((k) => (
                  <td key={k}>
                    {canWork ? <input type="number" aria-label={`${a.label}: ${k === 'low' ? t('aiPanel.bc.ariaLow') : k === 'base' ? t('aiPanel.bc.ariaBase') : t('aiPanel.bc.ariaHigh')}`} placeholder={t('aiPanel.bc.toClarify')} value={a[k] ?? ''} onChange={(e) => set(i, k, e.target.value)} style={{ width: 110 }} /> : a[k] == null ? t('aiPanel.bc.toClarify') : eur(a[k])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {canWork && (
        <div className="row">
          <label htmlFor={`years-${result.id}`}>{t('aiPanel.bc.years')}</label>
          <input id={`years-${result.id}`} type="number" min={1} max={10} value={years} onChange={(e) => setYears(Number(e.target.value))} style={{ width: 80 }} />
          <button type="button" onClick={recalc} disabled={busy}>{t('aiPanel.bc.recalc')}</button>
        </div>
      )}
      {!computed && <p className="alert info">{t('aiPanel.bc.noScenarios')}</p>}
      {computed && <>
      <div className="table-wrap" tabIndex={0}>
        <table>
          <caption className="sr-only">{t('aiPanel.bc.scenariosCaption')}</caption>
          <thead><tr><th scope="col">{t('aiPanel.bc.colScenario')}</th><th scope="col">{t('aiPanel.bc.colBenefit')}</th><th scope="col">{t('aiPanel.bc.colOneOff')}</th><th scope="col">{t('aiPanel.bc.colRunning')}</th><th scope="col">{t('aiPanel.bc.colPayback')}</th><th scope="col">{t('aiPanel.bc.colNet', { n: computed.horizonYears })}</th></tr></thead>
          <tbody>
            {computed.scenarios.map((s: any) => (
              <tr key={s.name}><th scope="row">{SC[s.name]}</th><td>{eur(s.annualBenefit)}</td><td>{eur(s.oneOffCost)}</td><td>{eur(s.annualRunningCost)}</td><td>{s.paybackMonths == null ? t('aiPanel.bc.noPayback') : t('aiPanel.bc.months', { n: s.paybackMonths })}</td><td>{eur(s.netOverHorizon)}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
      <details>
        <summary>{t('aiPanel.bc.sensitivity')}</summary>
        <ul>
          {computed.sensitivity.map((s: any) => <li key={s.id}>{t('aiPanel.bc.sensitivityItem', { label: s.label, minus: eur(s.minus20), plus: eur(s.plus20) })}</li>)}
        </ul>
      </details>
      <a className="button" href={`/api/ai/results/${result.id}/business-case.csv`} download>{t('aiPanel.bc.exportCsv')}</a>
      </>}
    </div>
  );
}

function PositioningMap({ result, canWork, onSaved }: { result: AiResult; canWork: boolean; onSaved: () => void }) {
  const d = result.data;
  const [x, setX] = useState(d.axisX);
  const [y, setY] = useState(d.axisY);
  const { busy, error, run } = useAction();
  const save = async () => {
    if (await run(() => api.put(`/api/ai/results/${result.id}/positioning`, { axisX: x, axisY: y, items: d.items }))) onSaved();
  };
  const REC = labelMap('aiPanel.pos.rec', ['buy', 'build', 'change_process', 'combine'] as const);
  const W = 360;
  return (
    <div className="stack">
      <svg viewBox={`0 0 ${W + 40} ${W + 40}`} width="100%" style={{ maxWidth: 420 }} role="img" aria-label={t('aiPanel.pos.mapLabel', { x: x.label, y: y.label })}>
        <rect x="30" y="0" width={W} height={W} fill="none" stroke="currentColor" opacity="0.3" />
        <text x={30 + W / 2} y={W + 30} textAnchor="middle" fontSize="12" fill="currentColor">{x.label} →</text>
        <text x="12" y={W / 2} textAnchor="middle" fontSize="12" fill="currentColor" transform={`rotate(-90 12 ${W / 2})`}>{y.label} →</text>
        {d.items.map((it: any) => (
          <g key={it.name}>
            <circle cx={30 + (it.x / 10) * W} cy={W - (it.y / 10) * W} r={it.isIdea ? 8 : 5} fill={it.isIdea ? 'var(--accent)' : 'var(--muted)'} />
            <text x={30 + (it.x / 10) * W + 10} y={W - (it.y / 10) * W + 4} fontSize="11" fill="currentColor">{it.name.slice(0, 28)}{it.priceOnRequest ? t('aiPanel.pos.priceOnRequestParen') : ''}</text>
          </g>
        ))}
      </svg>
      <ul className="small">
        {d.items.map((it: any) => <li key={it.name}>{it.name}: {x.label} {it.x}/10, {y.label} {it.y}/10{it.priceOnRequest ? t('aiPanel.pos.priceOnRequestList') : ''}</li>)}
      </ul>
      {d.items.some((it: any) => it.priceOnRequest) && <p className="alert warn">{t('aiPanel.pos.priceWarning')}</p>}
      <p><strong>{t('aiPanel.pos.recommendation', { rec: REC[d.recommendation] })}</strong>. {d.reasoning}</p>
      {canWork && (
        <details>
          <summary>{t('aiPanel.pos.changeAxes')}</summary>
          <ErrorBox error={error} />
          <div className="grid grid-2">
            <Field id={`ax-${result.id}`} label={t('aiPanel.pos.axisX')}><input id={`ax-${result.id}`} value={x.label} onChange={(e) => setX({ ...x, label: e.target.value })} /></Field>
            <Field id={`ay-${result.id}`} label={t('aiPanel.pos.axisY')}><input id={`ay-${result.id}`} value={y.label} onChange={(e) => setY({ ...y, label: e.target.value })} /></Field>
          </div>
          <button type="button" onClick={save} disabled={busy}>{t('aiPanel.pos.saveAxes')}</button>
        </details>
      )}
    </div>
  );
}

const RISK = labelMap('aiPanel.risk', ['privacy', 'ai_act', 'security', 'legal', 'patentability', 'employee_invention'] as const);
const LIGHT = labelMap('aiPanel.light', ['green', 'yellow', 'red'] as const);

/** Questions the analysis could not answer without data; the team fills them in (R2-40). */
function ToClarify({ items }: { items?: string[] }) {
  if (!items?.length) return null;
  return (
    <div className="alert info">
      <strong>{t('aiPanel.toClarify')}</strong>
      <ul>{items.map((q) => <li key={q}>{q}</li>)}</ul>
    </div>
  );
}

function ResultBody({ result, canWork, ideaId, onCorrect, reload }: { result: AiResult; canWork: boolean; ideaId: string; onCorrect: (c: Claim) => void; reload: () => void }) {
  const d = result.data;
  const adopt = useAction();
  const [adopted, setAdopted] = useState<string | null>(null);
  const take = async (what: 'dossier' | 'experiment') => {
    if (await adopt.run(() => api.post(`/api/ideas/${ideaId}/ai/adopt-${what}`, { resultId: result.id }))) {
      setAdopted(what === 'dossier' ? t('aiPanel.adopted.dossier') : t('aiPanel.adopted.experiment'));
      reload();
    }
  };
  switch (result.kind) {
    case 'triage_suggestion':
      return (
        <p>
          {t('aiPanel.triage.suggestion')} <strong>{LANES[d.lane]}</strong>, {t('aiPanel.triage.topic')} <strong>{d.topic}</strong> <span className="muted">({CONF[d.confidence as 'low']})</span>. {d.reason}
          {d.missing?.length > 0 && <><br />{t('aiPanel.triage.missing', { list: d.missing.join('; ') })}</>}
          <br /><span className="small muted">{t('aiPanel.triage.note')}</span>
        </p>
      );
    case 'short_analysis':
      return (
        <>
          <p>{d.summary}</p>
          {!d.completeness?.complete && <p className="alert warn">{t('aiPanel.short.incomplete', { list: d.completeness.missing.join('; ') })}</p>}
          <Sections result={result} canWork={canWork} onCorrect={onCorrect} />
        </>
      );
    case 'competition':
      return (
        <>
          <Sections result={result} canWork={canWork} onCorrect={onCorrect} />
          {d.matrix?.length > 0 && (
            <div className="table-wrap" tabIndex={0}>
              <table>
                <caption className="sr-only">{t('aiPanel.comp.caption')}</caption>
                <thead><tr><th scope="col">{t('aiPanel.comp.colSolution')}</th><th scope="col">{t('aiPanel.comp.colFeatures')}</th><th scope="col">{t('aiPanel.comp.colPrice')}</th><th scope="col">{t('aiPanel.comp.colStrengths')}</th><th scope="col">{t('aiPanel.comp.colWeaknesses')}</th><th scope="col">{t('aiPanel.comp.colSource')}</th></tr></thead>
                <tbody>
                  {d.matrix.map((m: any) => (
                    <tr key={m.name}><th scope="row">{m.name}</th><td>{m.features}</td><td>{m.priceOnRequest ? t('aiPanel.comp.onRequest') : m.price}</td><td>{m.strengths}</td><td>{m.weaknesses}</td><td>{m.sources.map((s: number) => <a key={s} href={`#src-${s}`}>[{s}]</a>)}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      );
    case 'patents':
      return (
        <>
          <p className="alert info">{t('aiPanel.patents.disclaimer')}</p>
          {d.hits?.length > 0 && (
            <ul>{d.hits.map((h: any) => <li key={h.source}><a href={`#src-${h.source}`}>{h.title}</a>{h.number ? ` (${h.number})` : ''}: {h.relevance}</li>)}</ul>
          )}
          <Sections result={result} canWork={canWork} onCorrect={onCorrect} />
        </>
      );
    case 'positioning':
      return <><PositioningMap result={result} canWork={canWork} onSaved={reload} /><ToClarify items={d.toClarify} /></>;
    case 'market_size': {
      const c = result.computed;
      if (!c) return <><ToClarify items={d.toClarify} /><Sections result={result} canWork={canWork} onCorrect={onCorrect} /></>;
      return (
        <>
          <div className="table-wrap" tabIndex={0}>
            <table>
              <caption className="sr-only">{t('aiPanel.market.caption')}</caption>
              <thead><tr><th scope="col">{t('aiPanel.market.colMethod')}</th><th scope="col">{t('aiPanel.market.colTam')}</th><th scope="col">{t('aiPanel.market.colSam')}</th><th scope="col">{t('aiPanel.market.colSom')}</th></tr></thead>
              <tbody>
                <tr><th scope="row">{t('aiPanel.market.topDown')}</th><td>{range(c.topDown.tam)}</td><td>{range(c.topDown.sam)}</td><td>{range(c.topDown.som)}</td></tr>
                <tr><th scope="row">{t('aiPanel.market.bottomUp')}</th><td>{range(c.bottomUp.tam)}</td><td>{range(c.bottomUp.sam)}</td><td>{range(c.bottomUp.som)}</td></tr>
              </tbody>
            </table>
          </div>
          <p className={c.somDeviation > 0.5 ? 'alert warn' : 'small muted'}>{t('aiPanel.market.deviation', { pct: Math.round(c.somDeviation * 100) })}</p>
          <Sections result={result} canWork={canWork} onCorrect={onCorrect} />
        </>
      );
    }
    case 'internal_market': {
      const c = result.computed;
      const AS = labelMap('aiPanel.internal.assessment', ['yes', 'maybe', 'no'] as const);
      return (
        <>
          {c ? <p>{t('aiPanel.internal.leverBefore')} <strong>{range(c.hoursPerYear, t('aiPanel.unitHours'))}</strong> {t('aiPanel.internal.leverMiddle')} <strong>{range(c.eurPerYear)}</strong>.</p> : <ToClarify items={d.toClarify} />}
          {d.solutions?.length > 0 && <ul>{d.solutions.map((s: any) => <li key={s.name}>{s.name}: {s.priceRange} {s.sources.map((n: number) => <a key={n} href={`#src-${n}`}>[{n}]</a>)}</li>)}</ul>}
          <p>{t('aiPanel.internal.marketable')} <strong>{AS[d.marketable.assessment]}</strong>. {d.marketable.reasoning}</p>
          <Sections result={result} canWork={canWork} onCorrect={onCorrect} />
        </>
      );
    }
    case 'business_case':
      return (
        <>
          <BusinessCase result={result} canWork={canWork} onSaved={reload} />
          <ToClarify items={d.toClarify} />
          <Sections result={result} canWork={canWork} onCorrect={onCorrect} />
        </>
      );
    case 'risk_check':
      return (
        <ul className="ai-claims">
          {d.areas.map((a: any) => (
            <li key={a.area}>
              <span className={`light ${a.light}`}>{LIGHT[a.light]}</span> <strong>{RISK[a.area]}</strong>: {a.finding} <span className="muted small">{t('aiPanel.risk.checks', { office: a.office })}</span>
            </li>
          ))}
        </ul>
      );
    case 'experiment':
      return (
        <>
          <dl className="ai-dl">
            <dt>{t('aiPanel.exp.hypothesis')}</dt><dd>{d.hypothesis}</dd>
            <dt>{t('aiPanel.exp.smallestTest')}</dt><dd>{d.smallestTest}</dd>
            <dt>{t('aiPanel.exp.metric')}</dt><dd>{d.metric}</dd>
            <dt>{t('aiPanel.exp.successCriteria')}</dt><dd>{d.successCriteria}</dd>
            <dt>{t('aiPanel.exp.duration')}</dt><dd>{t('aiPanel.exp.weeks', { n: d.durationWeeks })}</dd>
          </dl>
          <ErrorBox error={adopt.error} />
          {adopted && <div className="alert info" role="status">{adopted}</div>}
          {canWork && <button type="button" onClick={() => take('experiment')} disabled={adopt.busy}>{t('aiPanel.exp.adopt')}</button>}
        </>
      );
    case 'counterarguments':
      return (
        <>
          <h4>{t('aiPanel.counter.strongest')}</h4>
          <ol>{d.counterarguments.map((c: any, i: number) => <li key={i}>{c.text}</li>)}</ol>
          <h4>{t('aiPanel.counter.premortem')}</h4>
          <p>{d.premortem}</p>
          {d.earlyWarnings?.length > 0 && <><h4>{t('aiPanel.counter.earlyWarnings')}</h4><ul>{d.earlyWarnings.map((w: string) => <li key={w}>{w}</li>)}</ul></>}
        </>
      );
    case 'dossier_draft': {
      const SEC = labelMap('aiPanel.dossier.sec', ['benefit', 'effort', 'risks', 'affected', 'path', 'analyses'] as const);
      return (
        <>
          <p style={{ whiteSpace: 'pre-line' }}>{d.summary}</p>
          {d.parts.map((p: any) => (
            <details key={p.section}>
              <summary>{SEC[p.section]} {p.status === 'open' && <span className="badge yellow">{t('aiPanel.dossier.open')}</span>}</summary>
              <p style={{ whiteSpace: 'pre-line' }}>{p.content || '–'}</p>
              {p.openQuestions.length > 0 && <ul>{p.openQuestions.map((q: string) => <li key={q}>{t('aiPanel.dossier.openQuestion', { q })}</li>)}</ul>}
            </details>
          ))}
          <ErrorBox error={adopt.error} />
          {adopted && <div className="alert info" role="status">{adopted}</div>}
          {canWork && <button type="button" onClick={() => take('dossier')} disabled={adopt.busy}>{t('aiPanel.dossier.adopt')}</button>}
        </>
      );
    }
    default:
      return <Sections result={result} canWork={canWork} onCorrect={onCorrect} />;
  }
}

/** Review status per building block (R2-44): mentor and triage set it, everyone sees it. */
function ReviewControl({ result, canWork, onSaved }: { result: AiResult; canWork: boolean; onSaved: () => void }) {
  const { busy, error, run } = useAction();
  const review = result.review;
  if (!review) return null;
  const who = review.by && review.at ? ` (${t('aiQuality.review.by', { name: review.by, date: formatDate(review.at) })})` : '';
  const set = async (status: ReviewStatus) => {
    if (await run(() => api.put(`/api/ai/results/${result.id}/review`, { status }))) onSaved();
  };
  return (
    <div className="row small" style={{ gap: 8 }}>
      {canWork ? (
        <>
          <label htmlFor={`review-${result.id}`}>{t('aiQuality.review.label')}</label>
          <select id={`review-${result.id}`} value={review.status} disabled={busy} onChange={(e) => void set(e.target.value as ReviewStatus)}>
            {(['unchecked', 'checked', 'corrected'] as const).map((k) => <option key={k} value={k}>{REVIEW[k]}</option>)}
          </select>
          {who && <span className="muted">{who.trim()}</span>}
        </>
      ) : (
        <span>{t('aiQuality.review.label')}: <span className={`badge ${REVIEW_CLASS[review.status]}`}>{REVIEW[review.status]}</span>{who}</span>
      )}
      <ErrorBox error={error} />
    </div>
  );
}

/** One-click rating "hilfreich?" (R2-44); reported only aggregated, never per person. */
function Rating({ result }: { result: AiResult }) {
  const [value, setValue] = useState<boolean | null>(result.myRating ?? null);
  const { busy, error, run } = useAction();
  const rate = async (helpful: boolean) => {
    if (await run(() => api.post(`/api/ai/results/${result.id}/rating`, { helpful }))) setValue(helpful);
  };
  return (
    <div className="row small" style={{ gap: 6 }} role="group" aria-label={t('aiQuality.rating.question')}>
      <span>{t('aiQuality.rating.question')}</span>
      <button type="button" aria-pressed={value === true} className={value === true ? 'primary' : undefined} onClick={() => rate(true)} disabled={busy}>{t('aiQuality.rating.yes')}</button>
      <button type="button" aria-pressed={value === false} className={value === false ? 'primary' : undefined} onClick={() => rate(false)} disabled={busy}>{t('aiQuality.rating.no')}</button>
      {value !== null && <span className="muted" role="status">{t('aiQuality.rating.thanks')}</span>}
      <span className="muted">{t('aiQuality.rating.note')}</span>
      <ErrorBox error={error} />
    </div>
  );
}

/** Monthly sample (R2-46): the assigned mentor rates the result. */
export function SampleForm({ sampleId, month, verdict: initial, note: initialNote, onSaved }: { sampleId: string; month?: string; verdict: 'correct' | 'minor' | 'wrong' | null; note: string | null; onSaved?: () => void }) {
  const [verdict, setVerdict] = useState(initial);
  const [note, setNote] = useState(initialNote ?? '');
  const [saved, setSaved] = useState(initial);
  const { busy, error, run } = useAction();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!verdict) return;
    if (await run(() => api.put(`/api/ai/samples/${sampleId}`, { verdict, note: note.trim() || null }))) {
      setSaved(verdict);
      onSaved?.();
    }
  };
  return (
    <form onSubmit={submit} className="alert info stack" style={{ gap: 6 }}>
      <fieldset>
        <legend>{t('aiQuality.sample.legend', { month: month ?? '' })}</legend>
        {(['correct', 'minor', 'wrong'] as const).map((v) => (
          <label key={v} className="check"><input type="radio" name={`verdict-${sampleId}`} checked={verdict === v} onChange={() => setVerdict(v)} /> {VERDICT[v]}</label>
        ))}
      </fieldset>
      <Field id={`sample-note-${sampleId}`} label={t('aiQuality.sample.note')}>
        <input id={`sample-note-${sampleId}`} value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} />
      </Field>
      <ErrorBox error={error} />
      <div className="row">
        <button type="submit" disabled={busy || !verdict}>{t('aiQuality.sample.save')}</button>
        {saved && <span className="small muted" role="status">{t('aiQuality.sample.saved', { verdict: VERDICT[saved] })}</span>}
      </div>
    </form>
  );
}

// Expand rate (R2-44): shown and opened blocks are counted once per page view, without person.
const counted = new Set<string>();
function track(events: { kind: string; event: 'view' | 'open' }[]) {
  if (events.length) void api.post('/api/ai/usage', { events: events.slice(0, 30) }).catch(() => undefined);
}

export function AiPanel({ ideaId }: { ideaId: string }) {
  const { data, error, loading, reload } = useLoad<AiView>(`/api/ideas/${ideaId}/ai`);
  const [correcting, setCorrecting] = useState<{ resultId: string; claim: Claim } | null>(null);
  const start = useAction();
  const running = data?.jobs.some((j) => j.status === 'queued' || j.status === 'running');
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void reload(), 4000);
    return () => clearInterval(timer);
  }, [running, reload]);
  const results = [...(data?.results ?? [])].sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
  const viewKey = results.map((r) => r.id).join(',');
  useEffect(() => {
    const fresh = results.filter((r) => !DEFAULT_OPEN.includes(r.kind) && !counted.has(`view:${r.id}`));
    fresh.forEach((r) => counted.add(`view:${r.id}`));
    track(fresh.map((r) => ({ kind: r.kind, event: 'view' as const })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewKey]);
  if (error && /sehen|Berechtigung|permission/i.test(error)) return null;
  const onToggle = (r: AiResult) => (e: SyntheticEvent<HTMLDetailsElement>) => {
    if (!e.currentTarget.open || DEFAULT_OPEN.includes(r.kind) || counted.has(`open:${r.id}`)) return;
    counted.add(`open:${r.id}`);
    track([{ kind: r.kind, event: 'open' }]);
  };
  const runKind = async (kind: 'short' | 'full') => {
    if (await start.run(() => api.post(`/api/ideas/${ideaId}/ai/run`, { kind }))) await reload();
  };
  // People without work rights on the analysis (e.g. the submitter) get a short summary first;
  // system notices (model, costs, review status, sample) stay with the people who work on it.
  const simple = !!data && !data.canWork && !data.canConfigure;
  const renderResult = (r: AiResult) => (
    <details key={r.id} id={`ai-${r.kind}`} className="ai-result" open={!simple && DEFAULT_OPEN.includes(r.kind)} onToggle={onToggle(r)}>
      <summary>
        <strong>{KIND_LABEL[r.kind] ?? r.kind}</strong> <AiLabel meta={r.meta} /> <span className="small muted">{t('aiPanel.version', { v: r.version, date: new Date(r.createdAt).toLocaleDateString(intlLocale()) })}{r.edited ? t('aiPanel.edited') : ''}</span>
        {!simple && r.review && <> <span className={`badge ${REVIEW_CLASS[r.review.status]}`}>{REVIEW[r.review.status]}</span></>}
      </summary>
      {!simple && <ReviewControl result={r} canWork={!!data?.canWork} onSaved={reload} />}
      {r.meta.uncheckedModel && <div className="alert error" role="alert"><strong>{t('aiTransparency.unchecked.title')}</strong> {t('aiTransparency.unchecked.text', { model: r.meta.uncheckedModel })}</div>}
      {!simple && shownWarnings(r).length > 0 && <div className="alert warn small">{shownWarnings(r).join(' ')}</div>}
      {r.changes && (r.changes.added.length > 0 || r.changes.removed.length > 0) && (
        <details className="small">
          <summary>{t('aiPanel.changesSince', { v: r.version - 1 })}</summary>
          <ul>
            {r.changes.added.map((x) => <li key={`a${x}`}><ins>{t('aiPanel.changeAdded', { text: x })}</ins></li>)}
            {r.changes.removed.map((x) => <li key={`r${x}`}><del>{t('aiPanel.changeRemoved', { text: x })}</del></li>)}
          </ul>
        </details>
      )}
      <ResultBody result={r} canWork={!!data?.canWork} ideaId={ideaId} onCorrect={(claim) => setCorrecting({ resultId: r.id, claim })} reload={reload} />
      <SourceList sources={r.sources} />
      <Rating result={r} />
      {!simple && r.sample && <SampleForm sampleId={r.sample.id} month={r.sample.month} verdict={r.sample.verdict} note={r.sample.note} />}
    </details>
  );
  const proof = data && results.length > 0 && (
    <p className="small">
      <a href={`/api/ideas/${ideaId}/ai/proof.pdf`} download>{t('aiPanel.proofPdf')}</a>
      <span className="muted"> · {t('aiPanel.proofHint')}</span>
    </p>
  );
  if (simple) {
    const short = results.find((r) => r.kind === 'short_analysis');
    const missing: string[] = short?.data.completeness && !short.data.completeness.complete ? short.data.completeness.missing : [];
    return (
      <section className="card" aria-labelledby="h-ai">
        <h2 id="h-ai">{t('aiPanel.simple.heading')}</h2>
        <ErrorBox error={error} />
        {running && <p className="small muted" aria-live="polite">{t('aiPanel.simple.running')}</p>}
        {data && !data.enabled && <p className="muted">{t('aiPanel.disabled')}</p>}
        {data?.enabled && results.length === 0 && !running && <p className="muted">{t('aiPanel.simple.empty')}</p>}
        {short && (
          <>
            <p><AiLabel meta={short.meta} /> {short.data.summary}</p>
            {missing.length > 0 && <p className="alert info small">{t('aiPanel.simple.missing', { list: missing.join('; ') })}</p>}
          </>
        )}
        {results.length > 0 && (
          <details className="ai-more">
            <summary>{t('aiPanel.simple.showAll', { n: results.length })}</summary>
            <p className="small muted">{t('aiPanel.disclaimer')}</p>
            {results.map(renderResult)}
            {proof}
          </details>
        )}
        {correcting && <CorrectionDialog resultId={correcting.resultId} claim={correcting.claim} onClose={() => setCorrecting(null)} onDone={() => { setCorrecting(null); void reload(); }} />}
      </section>
    );
  }
  return (
    <section className="card" aria-labelledby="h-ai">
      <div className="row spread">
        <h2 id="h-ai">{t('aiPanel.heading')}</h2>
        {data && <span className="small muted">{t('aiPanel.costs', { spent: data.budget.spentEur.toFixed(2), limit: data.budget.limitEur })}</span>}
      </div>
      <p className="small muted">{t('aiPanel.disclaimer')}</p>
      {loading && !data ? <Loading /> : null}
      <ErrorBox error={error} />
      <ErrorBox error={start.error} />
      {data && !data.enabled && <p className="muted">{t('aiPanel.disabled')}</p>}
      {data?.enabled && !data.modelConfigured && (
        <div className="alert warn" role="note">
          <strong>{t('aiPanel.noModel.title')}</strong> {t('aiPanel.noModel.text')}
          {data.canConfigure ? <> <Link to="/einstellungen">{t('aiPanel.noModel.link')}</Link>.</> : ` ${t('aiPanel.noModel.admin')}`}
        </div>
      )}
      {data?.jobs.length ? (
        <ul className="small" aria-live="polite">
          {data.jobs.slice(0, 3).map((j, i) => (
            <li key={i}>{JOB_LABEL[j.kind] ?? j.kind}: {JOB_STATUS[j.status]}{j.error ? ` – ${j.error}` : ''}</li>
          ))}
        </ul>
      ) : null}
      {data?.canWork && data.enabled && (
        <div className="row">
          <button type="button" onClick={() => runKind('short')} disabled={start.busy || running}>{t('aiPanel.runShort')}</button>
          <button type="button" onClick={() => runKind('full')} disabled={start.busy || running}>{results.some((r) => r.kind === 'competition') ? t('aiPanel.runFullUpdate') : t('aiPanel.runFullStart')}</button>
        </div>
      )}
      {data && results.length === 0 && !running && <p className="muted">{t('aiPanel.empty')}</p>}
      {data?.reviewRequired && results.some((r) => r.review?.status === 'unchecked') && <p className="alert info small">{t('aiQuality.review.required')}</p>}
      {results.map(renderResult)}
      {proof}
      {correcting && <CorrectionDialog resultId={correcting.resultId} claim={correcting.claim} onClose={() => setCorrecting(null)} onDone={() => { setCorrecting(null); void reload(); }} />}
    </section>
  );
}

/** Summary of a long discussion on request (R2-21). */
export function DiscussionSummary({ ideaId, comments }: { ideaId: string; comments: number }) {
  const [res, setRes] = useState<{ summary: string; points: { kind: string; text: string; commentIds: string[] }[]; warnings: string[] } | null>(null);
  const { busy, error, run } = useAction();
  if (comments < 3) return null;
  const KIND = labelMap('aiPanel.discussion.kind', ['consensus', 'objection', 'question'] as const);
  const summarize = async () => {
    const r = await run(() => api.post<any>(`/api/ideas/${ideaId}/ai/discussion-summary`, {}));
    if (r) setRes(r);
  };
  return (
    <div className="stack">
      <button type="button" onClick={summarize} disabled={busy}>
        {busy ? t('aiPanel.discussion.busy') : t('aiPanel.discussion.button')}
      </button>
      <ErrorBox error={error} />
      {res && (
        <div className="alert info" role="status">
          <span className="badge accent">{t('aiPanel.label.draft')}</span> {res.summary}
          <ul>
            {res.points.map((p, i) => (
              <li key={i}>
                <strong>{KIND[p.kind]}:</strong> {p.text} {p.commentIds.map((id, n) => <a key={id} href={`#comment-${id}`} className="small">{t('aiPanel.discussion.commentRef', { n: n + 1 })}</a>)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Draft of the reply to the submitter, editable before sending (R2-19). */
export function ReplyDraftButton({ ideaId, lane, reason, onDraft }: { ideaId: string; lane: string; reason: string; onDraft: (text: string) => void }) {
  const { busy, error, run } = useAction();
  const draft = async () => {
    const r = await run(() => api.post<{ body: string }>(`/api/ideas/${ideaId}/ai/reply-draft`, { lane, reason }));
    if (r) onDraft(r.body);
  };
  return (
    <div>
      <button type="button" onClick={draft} disabled={busy}>
        {busy ? t('aiPanel.reply.busy') : t('aiPanel.reply.button')}
      </button>
      <ErrorBox error={error} />
    </div>
  );
}
