import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, type Criterion, type CustomField, type IdeaListItem, type UserRef } from '../api';
import { ErrorBox, Field, IdeaList, Loading, UserPicker, useAction, useLoad } from '../components';
import { formatDate, formatNumber, labelMap, t } from '../i18n';
import { hasRole, useSession } from '../session';
import { ScoreForm } from './idea/Elaboration';
import { ChallengeSuggestions } from '../ai/Extras';
import { ChallengeUseCases } from './ChallengeUseCases';
import { Gamification } from './Gamification';

interface Challenge {
  id: string;
  title: string;
  question: string;
  topic: string | null;
  contact: string;
  startsOn: string;
  endsOn: string;
  summary: string | null;
  active: boolean;
  ideas: number;
  phase: Phase | null;
  phasePlan: PhasePlan | null;
  acceptsIdeas: boolean;
}

// Phases with dates (R2-52) and crowd rating by fixed criteria (R2-51).
const PHASES = ['collect', 'rate', 'elaborate', 'jury', 'result'] as const;
type Phase = (typeof PHASES)[number];
type PhasePlan = Record<Phase, string>;
const PHASE_LABELS = labelMap('challenges.phase', PHASES);

interface RatingCriterion {
  id: string;
  label: string;
}

interface Template {
  id: string;
  name: string;
  title: string;
  question: string;
  topic: string | null;
  teamsAllowed: boolean;
  ratingCriteria: RatingCriterion[];
  customFields: CustomField[];
  phaseDays: Record<Phase, number>;
  /** R3-32 … R3-34: suggested benefit kind of the target and hackathon mode. */
  targetKind?: string | null;
  hackathon?: boolean;
}

interface CrowdRating {
  criteria: RatingCriterion[];
  open: boolean;
  minRatings: number;
  aggregates: Record<string, { count: number; criteria: { id: string; mean: number; sd: number }[] | null }>;
  mine: Record<string, Record<string, number>>;
  ownIdeas: string[];
}

const DEFAULT_DAYS: Record<Phase, number> = { collect: 28, rate: 7, elaborate: 14, jury: 7, result: 14 };

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Phase plan from a start date and the length of each phase; returns the plan and the end date. */
function planFrom(start: string, days: Record<Phase, number>): { plan: PhasePlan; end: string } {
  const plan = {} as PhasePlan;
  let day = start;
  for (const p of PHASES) {
    plan[p] = day;
    day = addDays(day, days[p]);
  }
  return { plan, end: addDays(day, -1) };
}

interface RankingRow {
  id: string;
  number: number;
  title: string;
  teamName: string | null;
  total: number | null;
  ratings: number;
  rank: number | null;
}

interface ChallengeDetailData extends Omit<Challenge, 'ideas'> {
  template: string | null;
  ownRatingCriteria: RatingCriterion[];
  crowdRating: CrowdRating | null;
  ideas: IdeaListItem[];
  customFields: CustomField[];
  teamsAllowed: boolean;
  ownJuryCriteria: Criterion[];
  juryCriteria: Criterion[];
  jury: UserRef[];
  isJury: boolean;
  ended: boolean;
  rankingPublishedAt: string | null;
  ranking: RankingRow[] | null;
  myJuryScores: Record<string, { scores: Record<string, number>; total: number; comment: string | null }>;
  can: { manage: boolean; publishRanking: boolean };
}

const FIELD_TYPES = labelMap('challenges.fieldType', ['text', 'number', 'select'] as const);

/** Field id from its label: lower case, ASCII, unique. */
function slug(label: string, taken: string[]): string {
  const base = label
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss') // texts-ok
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 34) || 'feld';
  let id = base;
  for (let n = 2; taken.includes(id); n++) id = `${base}_${n}`;
  return id;
}

/** Editor for the challenge's own submission fields (R2-35). */
function CustomFieldsEditor({ fields, onChange, idPrefix }: { fields: CustomField[]; onChange: (f: CustomField[]) => void; idPrefix: string }) {
  const set = (i: number, patch: Partial<CustomField>) => onChange(fields.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  return (
    <fieldset>
      <legend>{t('challenges.fields.legend')}</legend>
      {fields.length === 0 && <p className="small muted">{t('challenges.fields.none')}</p>}
      {fields.map((f, i) => (
        <div key={i} className="grid grid-3 field-row">
          <Field id={`${idPrefix}-label-${i}`} label={t('challenges.fields.label')}>
            <input id={`${idPrefix}-label-${i}`} type="text" value={f.label} onChange={(e) => set(i, { label: e.target.value })} required />
          </Field>
          <Field id={`${idPrefix}-type-${i}`} label={t('challenges.fields.type')}>
            <select id={`${idPrefix}-type-${i}`} value={f.type} onChange={(e) => set(i, { type: e.target.value as CustomField['type'] })}>
              {Object.entries(FIELD_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </Field>
          {f.type === 'select' ? (
            <Field id={`${idPrefix}-opts-${i}`} label={t('challenges.fields.options')} hint={t('challenges.fields.optionsHint')}>
              <input id={`${idPrefix}-opts-${i}`} type="text" value={f.options.join(', ')} aria-describedby={`${idPrefix}-opts-${i}-hint`}
                onChange={(e) => set(i, { options: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} />
            </Field>
          ) : <div />}
          <label className="check">
            <input type="checkbox" checked={f.required} onChange={(e) => set(i, { required: e.target.checked })} /> {t('challenges.fields.required')}
          </label>
          <button type="button" className="link" onClick={() => onChange(fields.filter((_, j) => j !== i))} aria-label={t('challenges.fields.removeLabel', { name: f.label || i + 1 })}>{t('challenges.remove')}</button>
        </div>
      ))}
      <button type="button" onClick={() => onChange([...fields, { id: '', label: '', type: 'text', options: [], required: false }])} disabled={fields.length >= 20}>
        {t('challenges.fields.add')}
      </button>
    </fieldset>
  );
}

const withIds = (fields: CustomField[]): CustomField[] => {
  const taken: string[] = [];
  return fields.map((f) => {
    const id = f.id || slug(f.label, taken);
    taken.push(id);
    return { ...f, id };
  });
};

/** Start dates of the five phases (R2-52). */
function PhasePlanEditor({ plan, onChange, idPrefix }: { plan: PhasePlan; onChange: (p: PhasePlan) => void; idPrefix: string }) {
  return (
    <fieldset>
      <legend>{t('challenges.phases.legend')}</legend>
      <p className="small muted">{t('challenges.phases.hint')}</p>
      <div className="grid grid-3">
        {PHASES.map((p) => (
          <Field key={p} id={`${idPrefix}-${p}`} label={PHASE_LABELS[p]}>
            <input id={`${idPrefix}-${p}`} type="date" value={plan[p]} onChange={(e) => onChange({ ...plan, [p]: e.target.value })} required />
          </Field>
        ))}
      </div>
    </fieldset>
  );
}

/** Criteria of the crowd rating (R2-51), each rated from 1 to 5. */
function RatingCriteriaEditor({ criteria, onChange, idPrefix }: { criteria: RatingCriterion[]; onChange: (c: RatingCriterion[]) => void; idPrefix: string }) {
  return (
    <fieldset>
      <legend>{t('challenges.crowd.legend')}</legend>
      <p className="small muted">{t('challenges.crowd.criteriaHint')}</p>
      {criteria.map((c, i) => (
        <div key={i} className="row field-row">
          <Field id={`${idPrefix}-${i}`} label={t('challenges.crowd.criterion')}>
            <input id={`${idPrefix}-${i}`} type="text" maxLength={80} value={c.label} onChange={(e) => onChange(criteria.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
          </Field>
          <button type="button" className="link" onClick={() => onChange(criteria.filter((_, j) => j !== i))} aria-label={t('challenges.crowd.removeCriterion', { name: c.label || i + 1 })}>{t('challenges.remove')}</button>
        </div>
      ))}
      <button type="button" onClick={() => onChange([...criteria, { id: '', label: '' }])} disabled={criteria.length >= 6}>{t('challenges.crowd.addCriterion')}</button>
    </fieldset>
  );
}

/** Ids for criteria entered by label; existing ids are kept. */
function criteriaWithIds(criteria: RatingCriterion[]): RatingCriterion[] {
  const taken: string[] = [];
  return criteria.filter((c) => c.label.trim()).map((c) => {
    const id = c.id || slug(c.label, taken);
    taken.push(id);
    return { id, label: c.label.trim() };
  });
}

// Challenges with topic, period and contact (R1-34), own fields, teams, jury and ranking (R2-35).
export function Challenges() {
  const { me, settings } = useSession();
  const list = useLoad<Challenge[]>('/api/challenges');
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ title: '', question: '', topic: '', contact: me.user.displayName, startsOn: settings.today, endsOn: '' });
  const [fields, setFields] = useState<CustomField[]>([]);
  const [teamsAllowed, setTeamsAllowed] = useState(false);
  const [usePhases, setUsePhases] = useState(false);
  const [plan, setPlan] = useState<PhasePlan>(() => planFrom(settings.today, DEFAULT_DAYS).plan);
  const [ratingCriteria, setRatingCriteria] = useState<RatingCriterion[]>([]);
  const [template, setTemplate] = useState('');
  const [hackathon, setHackathon] = useState(false);
  const { busy, error, run } = useAction();
  const canCreate = hasRole(me, 'admin', 'triage', 'committee');
  const templates = useLoad<Template[]>(canCreate && open ? '/api/challenges/templates' : null);
  const applyTemplate = (id: string) => {
    setTemplate(id);
    const tpl = templates.data?.find((x) => x.id === id);
    if (!tpl) return;
    const { plan: p, end } = planFrom(form.startsOn || settings.today, tpl.phaseDays);
    setForm({ ...form, title: tpl.title, question: tpl.question, topic: tpl.topic ?? form.topic, endsOn: end });
    setFields(tpl.customFields);
    setTeamsAllowed(tpl.teamsAllowed);
    setRatingCriteria(tpl.ratingCriteria);
    setUsePhases(true);
    setPlan(p);
    setHackathon(!!tpl.hackathon);
  };
  const togglePhases = (on: boolean) => {
    setUsePhases(on);
    if (on) {
      const { plan: p, end } = planFrom(form.startsOn || settings.today, DEFAULT_DAYS);
      setPlan(p);
      if (!form.endsOn || form.endsOn < p.result) setForm({ ...form, endsOn: end });
    }
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const body = {
      ...form, topic: form.topic || null, customFields: withIds(fields), teamsAllowed,
      phasePlan: usePhases ? plan : null, ratingCriteria: criteriaWithIds(ratingCriteria), template: template || null,
      ...(hackathon ? { hackathon: true } : {}),
    };
    if (await run(() => api.post('/api/challenges', body))) {
      setOpen(false);
      setFields([]);
      setTeamsAllowed(false);
      setUsePhases(false);
      setRatingCriteria([]);
      setTemplate('');
      list.reload();
    }
  };
  return (
    <div className="stack">
      <div className="row spread">
        <h1>{t('challenges.title')}</h1>
        {canCreate && !open && <button className="primary" onClick={() => setOpen(true)}>{t('challenges.start')}</button>}
      </div>
      {open && (
        <form className="card" onSubmit={submit}>
          <h2>{t('challenges.new.title')}</h2>
          <ErrorBox error={error} />
          {templates.data && templates.data.length > 0 && (
            <Field id="c-template" label={t('challenges.template.label')} hint={t('challenges.template.hint')}>
              <select id="c-template" value={template} aria-describedby="c-template-hint" onChange={(e) => applyTemplate(e.target.value)}>
                <option value="">{t('challenges.template.none')}</option>
                {templates.data.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </select>
            </Field>
          )}
          <ChallengeSuggestions onApply={(s) => setForm({ ...form, title: s.title, question: s.question, topic: s.topic && settings.topics.includes(s.topic) ? s.topic : form.topic })} />
          <Field id="c-title" label={t('challenges.new.name')}><input id="c-title" type="text" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} required /></Field>
          <Field id="c-question" label={t('challenges.new.question')}><textarea id="c-question" value={form.question} onChange={(e) => setForm({ ...form, question: e.target.value })} required /></Field>
          <div className="grid grid-3">
            <Field id="c-topic" label={t('challenges.new.topic')}>
              <select id="c-topic" value={form.topic} onChange={(e) => setForm({ ...form, topic: e.target.value })}>
                <option value="">{t('challenges.new.noTopic')}</option>
                {settings.topics.map((topic) => <option key={topic}>{topic}</option>)}
              </select>
            </Field>
            <Field id="c-start" label={t('challenges.new.start')}><input id="c-start" type="date" value={form.startsOn} onChange={(e) => setForm({ ...form, startsOn: e.target.value })} required /></Field>
            <Field id="c-end" label={t('challenges.new.end')}><input id="c-end" type="date" value={form.endsOn} onChange={(e) => setForm({ ...form, endsOn: e.target.value })} required /></Field>
          </div>
          <Field id="c-contact" label={t('challenges.new.contact')}><input id="c-contact" type="text" value={form.contact} onChange={(e) => setForm({ ...form, contact: e.target.value })} required /></Field>
          <CustomFieldsEditor fields={fields} onChange={setFields} idPrefix="c-field" />
          <label className="check">
            <input type="checkbox" checked={teamsAllowed} onChange={(e) => setTeamsAllowed(e.target.checked)} /> {t('challenges.teamsAllowed')}
          </label>
          <label className="check">
            <input type="checkbox" checked={usePhases} onChange={(e) => togglePhases(e.target.checked)} /> {t('challenges.phases.use')}
          </label>
          {usePhases && <PhasePlanEditor plan={plan} onChange={setPlan} idPrefix="c-phase" />}
          <RatingCriteriaEditor criteria={ratingCriteria} onChange={setRatingCriteria} idPrefix="c-crit" />
          <label className="check">
            <input type="checkbox" checked={hackathon} onChange={(e) => setHackathon(e.target.checked)} /> {t('usecases.manage.hackathon')}
          </label>
          <p className="hint">{t('challenges.new.juryHint')}</p>
          <div className="row">
            <button type="button" onClick={() => setOpen(false)}>{t('challenges.new.cancel')}</button>
            <button className="primary" disabled={busy}>{t('challenges.new.submit')}</button>
          </div>
        </form>
      )}
      <ErrorBox error={list.error} />
      {list.loading && !list.data ? <Loading /> : (
        <div className="grid grid-2">
          {(list.data ?? []).map((c) => (
            <Link key={c.id} to={`/challenges/${c.id}`} className="card" style={{ color: 'inherit', textDecoration: 'none' }}>
              <div className="row spread">
                <h2 style={{ margin: 0 }}>{c.title}</h2>
                <span className={`badge ${c.active ? 'green' : ''}`}>{c.active ? t('challenges.active') : t('challenges.ended')}</span>
              </div>
              {c.phasePlan && <p className="small"><span className="badge accent">{t('challenges.phase.current', { phase: c.phase ? PHASE_LABELS[c.phase] : t('challenges.phase.planned') })}</span></p>}
              <p>{c.question}</p>
              <p className="small muted">{t('challenges.period', { from: formatDate(c.startsOn), to: formatDate(c.endsOn) })} · {t('challenges.ideaCount', { n: c.ideas })}</p>
            </Link>
          ))}
          {list.data?.length === 0 && <p className="muted">{t('challenges.empty')}</p>}
        </div>
      )}
    </div>
  );
}

export function ChallengeDetail() {
  const { id } = useParams();
  const { me } = useSession();
  const { data, error, loading, reload } = useLoad<ChallengeDetailData>(`/api/challenges/${id}`);
  const { busy, error: closeError, run } = useAction();
  const [message, setMessage] = useState<string | null>(null);
  if (loading && !data) return <Loading />;
  if (!data) return <ErrorBox error={error} />;
  const canClose = hasRole(me, 'admin', 'triage', 'committee') && data.active && !data.summary;
  return (
    <div className="stack">
      <div className="card">
        <div className="row spread">
          <h1>{data.title}</h1>
          <span className={`badge ${data.active && !data.ended ? 'green' : ''}`}>{data.active && !data.ended ? t('challenges.active') : t('challenges.ended')}</span>
        </div>
        <p>{data.question}</p>
        <p className="small muted">
          {t('challenges.period', { from: formatDate(data.startsOn), to: formatDate(data.endsOn) })} · {t('challenges.detail.contact', { name: data.contact })}
          {data.topic && ` · ${data.topic}`}
          {data.teamsAllowed && ` · ${t('challenges.detail.teamsWelcome')}`}
          {data.jury.length > 0 && ` · ${t('challenges.detail.jury', { names: data.jury.map((j) => j.displayName).join(', ') })}`}
        </p>
        {data.phasePlan && <PhaseTimeline plan={data.phasePlan} phase={data.phase} />}
        {data.summary && <div className="alert info"><strong>{t('challenges.detail.summary')}</strong> {data.summary}</div>}
        <ErrorBox error={closeError} />
        {message && <p className="alert success" role="status">{message}</p>}
        <div className="row">
          {data.active && !data.ended && data.acceptsIdeas && <Link to="/einreichen" className="button primary">{t('challenges.detail.submitIdea')}</Link>}
          {data.active && !data.ended && !data.acceptsIdeas && <p className="small muted">{t('challenges.phases.notCollecting')}</p>}
          {canClose && <button disabled={busy} onClick={async () => (await run(() => api.post(`/api/challenges/${data.id}/close`, {}))) && reload()}>{t('challenges.detail.close')}</button>}
          {data.can.publishRanking && (
            <button className="primary" disabled={busy}
              onClick={async () => { if (await run(() => api.post(`/api/challenges/${data.id}/ranking/publish`))) { setMessage(t('challenges.detail.rankingPublished')); reload(); } }}>
              {t('challenges.detail.publishRanking')}
            </button>
          )}
        </div>
      </div>
      {data.crowdRating && <CrowdRatingSection data={data} crowd={data.crowdRating} onDone={() => void reload()} />}
      {data.ranking && <Ranking data={data} />}
      {data.isJury && <JuryRating data={data} onDone={() => void reload()} />}
      <Gamification challengeId={data.id} />
      <ChallengeUseCases challengeId={data.id} canExport={hasRole(me, 'admin', 'triage', 'committee', 'lead')} />
      {data.can.manage && <ManageChallenge data={data} onDone={() => void reload()} />}
      <section className="card">
        <h2>{t('challenges.detail.ideas')}</h2>
        <IdeaList ideas={data.ideas} empty={t('challenges.detail.noIdeas')} />
      </section>
    </div>
  );
}

function PhaseTimeline({ plan, phase }: { plan: PhasePlan; phase: Phase | null }) {
  return (
    <section aria-labelledby="h-phases">
      <h2 id="h-phases" className="small" style={{ margin: '8px 0 4px' }}>{t('challenges.phases.title')}</h2>
      <ol className="row" style={{ listStyle: 'none', padding: 0, margin: 0, flexWrap: 'wrap' }}>
        {PHASES.map((p) => (
          <li key={p} aria-current={p === phase ? 'step' : undefined}>
            <span className={`badge ${p === phase ? 'green' : ''}`}>{PHASE_LABELS[p]} · {t('challenges.phases.startsOn', { date: formatDate(plan[p]) })}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** Crowd rating (R2-51): aggregates per idea from the minimum group size on, and the own rating. */
function CrowdRatingSection({ data, crowd, onDone }: { data: ChallengeDetailData; crowd: CrowdRating; onDone: () => void }) {
  const { busy, error, run } = useAction();
  const [saved, setSaved] = useState<string | null>(null);
  const ideas = data.ideas.filter((i) => i.status !== 'draft');
  const save = async (ideaId: string, scores: Record<string, number>) => {
    setSaved(null);
    if (await run(() => api.put(`/api/challenges/${data.id}/ideas/${ideaId}/rating`, { scores }))) {
      setSaved(t('challenges.crowd.saved'));
      onDone();
    }
  };
  return (
    <section className="card" aria-labelledby="h-crowd">
      <h2 id="h-crowd">{t('challenges.crowd.title')}</h2>
      <p className="small muted">{t('challenges.crowd.intro', { n: crowd.minRatings })}</p>
      <p className="small">{crowd.open ? t('challenges.crowd.open') : data.phasePlan ? t('challenges.crowd.closedPhases') : t('challenges.crowd.closed')}</p>
      <ErrorBox error={error} />
      {saved && <p className="alert success" role="status">{saved}</p>}
      {ideas.length === 0 ? <p className="muted">{t('challenges.noIdeas')}</p> : (
        <>
          <div className="table-wrap" tabIndex={0}><table>
            <thead>
              <tr>
                <th scope="col">{t('challenges.crowd.idea')}</th>
                {crowd.criteria.map((c) => <th key={c.id} scope="col">{c.label}</th>)}
                <th scope="col">{t('challenges.crowd.count')}</th>
                <th scope="col">{t('challenges.crowd.yours')}</th>
              </tr>
            </thead>
            <tbody>
              {ideas.map((i) => {
                const agg = crowd.aggregates[i.id] ?? { count: 0, criteria: null };
                const mine = crowd.mine[i.id];
                return (
                  <tr key={i.id}>
                    <td><Link to={`/ideen/${i.id}`}>#{i.number} {i.title}</Link></td>
                    {crowd.criteria.map((c) => {
                      const v = agg.criteria?.find((x) => x.id === c.id);
                      return <td key={c.id}>{v ? t('challenges.crowd.value', { mean: formatNumber(v.mean, 1), sd: formatNumber(v.sd, 1) }) : t('challenges.crowd.hidden', { n: crowd.minRatings })}</td>;
                    })}
                    <td>{agg.count}</td>
                    <td>
                      {crowd.ownIdeas.includes(i.id) ? t('challenges.crowd.ownIdea')
                        : mine ? crowd.criteria.map((c) => `${c.label} ${mine[c.id] ?? '–'}`).join(' · ')
                        : t('challenges.crowd.notRated')}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table></div>
          <p className="small muted">{t('challenges.crowd.valueNote')} {t('challenges.crowd.hiddenNote', { n: crowd.minRatings })}</p>
          {crowd.open && ideas.filter((i) => !crowd.ownIdeas.includes(i.id)).map((i) => (
            <details key={i.id} className="jury-item">
              <summary>{t('challenges.crowd.rateIdea', { number: i.number, title: i.title })}{crowd.mine[i.id] ? ` · ${t('challenges.crowd.change')}` : ''}</summary>
              <CrowdRatingForm idPrefix={`crowd-${i.number}`} criteria={crowd.criteria} initial={crowd.mine[i.id] ?? null} busy={busy} onSubmit={(scores) => save(i.id, scores)} />
            </details>
          ))}
        </>
      )}
    </section>
  );
}

function CrowdRatingForm({ idPrefix, criteria, initial, busy, onSubmit }: {
  idPrefix: string; criteria: RatingCriterion[]; initial: Record<string, number> | null; busy: boolean; onSubmit: (scores: Record<string, number>) => void;
}) {
  const [scores, setScores] = useState<Record<string, number>>(initial ?? {});
  const complete = criteria.every((c) => scores[c.id] >= 1);
  return (
    <form onSubmit={(e) => { e.preventDefault(); if (complete) onSubmit(scores); }}>
      <div className="grid grid-3">
        {criteria.map((c) => (
          <Field key={c.id} id={`${idPrefix}-${c.id}`} label={c.label}>
            <select id={`${idPrefix}-${c.id}`} value={scores[c.id] ?? ''} required onChange={(e) => setScores({ ...scores, [c.id]: Number(e.target.value) })}>
              <option value="">{t('challenges.crowd.choose')}</option>
              {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </Field>
        ))}
      </div>
      <button className="primary" disabled={busy || !complete}>{t('challenges.crowd.save')}</button>
    </form>
  );
}

function Ranking({ data }: { data: ChallengeDetailData }) {
  const ranking = data.ranking!;
  return (
    <section className="card" aria-labelledby="h-ranking">
      <h2 id="h-ranking">{t('challenges.ranking.title')}</h2>
      <p className="small muted">
        {t('challenges.ranking.intro')}{' '}
        {data.rankingPublishedAt ? t('challenges.ranking.publishedOn', { date: formatDate(data.rankingPublishedAt) }) : t('challenges.ranking.notPublished')}
      </p>
      {ranking.length === 0 ? <p className="muted">{t('challenges.noIdeas')}</p> : (
        <div className="table-wrap" tabIndex={0}><table>
          <thead><tr><th scope="col">{t('challenges.ranking.rank')}</th><th scope="col">{t('challenges.ranking.idea')}</th><th scope="col">{t('challenges.ranking.score')}</th><th scope="col">{t('challenges.ranking.ratings')}</th></tr></thead>
          <tbody>
            {ranking.map((r) => (
              <tr key={r.id}>
                <td>{r.rank ?? '–'}</td>
                <td><Link to={`/ideen/${r.id}`}>#{r.number} {r.title}</Link>{r.teamName && <span className="small muted"> · {r.teamName}</span>}</td>
                <td>{r.total != null ? formatNumber(r.total) : '–'}</td>
                <td>{r.ratings}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
    </section>
  );
}

function JuryRating({ data, onDone }: { data: ChallengeDetailData; onDone: () => void }) {
  const { error, run } = useAction();
  return (
    <section className="card" aria-labelledby="h-jury">
      <h2 id="h-jury">{t('challenges.jury.title')}</h2>
      <p className="small muted">{t('challenges.jury.intro')}</p>
      <ErrorBox error={error} />
      {data.ideas.length === 0 && <p className="muted">{t('challenges.noIdeas')}</p>}
      {data.ideas.map((i) => {
        const mine = data.myJuryScores[i.id];
        return (
          <details key={i.id} className="jury-item">
            <summary>
              #{i.number} {i.title} {mine ? <span className="badge green">{t('challenges.jury.rated', { total: formatNumber(mine.total) })}</span> : <span className="badge">{t('challenges.jury.open')}</span>}
            </summary>
            <p className="small"><Link to={`/ideen/${i.id}`}>{t('challenges.jury.openIdea')}</Link></p>
            <ScoreForm
              idPrefix={`jury-${i.number}`}
              criteria={data.juryCriteria}
              initial={mine ?? null}
              onSubmit={async (scores, comment) => {
                const r = await run(() => api.put(`/api/challenges/${data.id}/ideas/${i.id}/jury-score`, { scores, comment }));
                if (r) onDone();
                return !!r;
              }}
            />
          </details>
        );
      })}
    </section>
  );
}

function ManageChallenge({ data, onDone }: { data: ChallengeDetailData; onDone: () => void }) {
  const [fields, setFields] = useState<CustomField[]>(data.customFields);
  const [teamsAllowed, setTeamsAllowed] = useState(data.teamsAllowed);
  const [criteria, setCriteria] = useState<{ label: string; weight: number }[]>(data.ownJuryCriteria.map((c) => ({ label: c.label, weight: c.weight })));
  const [jury, setJury] = useState<UserRef[]>(data.jury);
  const [person, setPerson] = useState<UserRef | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [usePhases, setUsePhases] = useState(!!data.phasePlan);
  const [plan, setPlan] = useState<PhasePlan>(data.phasePlan ?? planFrom(data.startsOn, DEFAULT_DAYS).plan);
  const [ratingCriteria, setRatingCriteria] = useState<RatingCriterion[]>(data.ownRatingCriteria ?? []);
  const { busy, error, run } = useAction();
  const savePhases = async (e: FormEvent) => {
    e.preventDefault();
    setSaved(null);
    if (await run(() => api.patch(`/api/challenges/${data.id}`, { phasePlan: usePhases ? plan : null, ratingCriteria: criteriaWithIds(ratingCriteria) }))) {
      setSaved(t('challenges.manage.phasesSaved'));
      onDone();
    }
  };
  const saveSettings = async (e: FormEvent) => {
    e.preventDefault();
    setSaved(null);
    const taken: string[] = [];
    const juryCriteria = criteria.filter((c) => c.label.trim()).map((c) => {
      const id = slug(c.label, taken);
      taken.push(id);
      return { id, label: c.label.trim(), weight: c.weight };
    });
    if (await run(() => api.patch(`/api/challenges/${data.id}`, { customFields: withIds(fields), teamsAllowed, juryCriteria }))) {
      setSaved(t('challenges.manage.settingsSaved'));
      onDone();
    }
  };
  const saveJury = async (next: UserRef[]) => {
    setSaved(null);
    if (await run(() => api.put(`/api/challenges/${data.id}/jury`, { userIds: next.map((u) => u.id) }))) {
      setJury(next);
      setSaved(t('challenges.manage.jurySaved'));
      onDone();
    }
  };
  return (
    <section className="card" aria-labelledby="h-manage">
      <h2 id="h-manage">{t('challenges.manage.title')}</h2>
      <ErrorBox error={error} />
      {saved && <p className="alert success" role="status">{saved}</p>}
      <h3>{t('challenges.manage.jury')}</h3>
      {jury.length === 0 && <p className="small muted">{t('challenges.manage.noJury')}</p>}
      <ul className="idea-list">
        {jury.map((u) => (
          <li key={u.id} className="row spread">
            {u.displayName}
            <button type="button" className="link" disabled={busy} onClick={() => saveJury(jury.filter((x) => x.id !== u.id))} aria-label={t('challenges.manage.removeJuror', { name: u.displayName })}>{t('challenges.remove')}</button>
          </li>
        ))}
      </ul>
      <Field id="jury-add" label={t('challenges.manage.addJuror')}>
        <UserPicker id="jury-add" value={person} onChange={setPerson} />
      </Field>
      <button type="button" disabled={!person || busy} onClick={async () => { if (person && !jury.some((j) => j.id === person.id)) await saveJury([...jury, person]); setPerson(null); }}>
        {t('challenges.manage.add')}
      </button>
      <form onSubmit={saveSettings} style={{ marginTop: 20 }}>
        <h3>{t('challenges.manage.settingsTitle')}</h3>
        <CustomFieldsEditor fields={fields} onChange={setFields} idPrefix="m-field" />
        <label className="check">
          <input type="checkbox" checked={teamsAllowed} onChange={(e) => setTeamsAllowed(e.target.checked)} /> {t('challenges.teamsAllowed')}
        </label>
        <fieldset>
          <legend>{t('challenges.manage.criteria')}</legend>
          <p className="small muted">{t('challenges.manage.criteriaHint')}</p>
          {criteria.map((c, i) => (
            <div key={i} className="grid grid-3 field-row">
              <Field id={`jc-label-${i}`} label={t('challenges.manage.criterion')}>
                <input id={`jc-label-${i}`} type="text" value={c.label} onChange={(e) => setCriteria(criteria.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
              </Field>
              <Field id={`jc-weight-${i}`} label={t('challenges.manage.weight')}>
                <input id={`jc-weight-${i}`} type="number" min={1} max={100} value={c.weight} onChange={(e) => setCriteria(criteria.map((x, j) => (j === i ? { ...x, weight: Number(e.target.value) } : x)))} />
              </Field>
              <button type="button" className="link" onClick={() => setCriteria(criteria.filter((_, j) => j !== i))} aria-label={t('challenges.manage.removeCriterion', { name: c.label || i + 1 })}>{t('challenges.remove')}</button>
            </div>
          ))}
          <button type="button" onClick={() => setCriteria([...criteria, { label: '', weight: 25 }])} disabled={criteria.length >= 12}>{t('challenges.manage.addCriterion')}</button>
        </fieldset>
        <button className="primary" disabled={busy}>{t('challenges.manage.save')}</button>
      </form>
      <form onSubmit={savePhases} style={{ marginTop: 20 }}>
        <h3>{t('challenges.manage.phasesTitle')}</h3>
        <label className="check">
          <input type="checkbox" checked={usePhases} onChange={(e) => setUsePhases(e.target.checked)} /> {t('challenges.phases.use')}
        </label>
        {usePhases && <PhasePlanEditor plan={plan} onChange={setPlan} idPrefix="m-phase" />}
        <RatingCriteriaEditor criteria={ratingCriteria} onChange={setRatingCriteria} idPrefix="m-crit" />
        <button className="primary" disabled={busy}>{t('challenges.manage.save')}</button>
      </form>
    </section>
  );
}
