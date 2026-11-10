import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ApiError, api, type CustomField, type UserRef } from '../api';
import { Dialog, ErrorBox, Field, UserPicker, useAction, useLoad } from '../components';
import { STATUS_SHORT } from '../labels';
import { t } from '../i18n';
import { useSession } from '../session';
import { Coach, PhotoSuggest, VoiceButton, type IdeaFields } from '../ai/SubmitAssist';

interface Similar {
  id: string;
  number: number;
  title: string;
  status: string;
  score: number;
}

interface BoundaryMatch {
  category: string;
  label: string;
  keywords: string[];
  channel: { name: string; contact: string; url: string } | null;
}

interface Form {
  title: string;
  problem: string;
  solution: string;
  benefit: string;
  topic: string;
  ideaType: 'internal' | 'product';
  /** Problem exchange (R3-31): a problem needs no solution. */
  ideaKind: 'idea' | 'problem';
  confidential: boolean;
  anonymous: boolean;
  challengeId: string;
  customValues: Record<string, string>;
  teamName: string;
}

const EMPTY: Form = {
  title: '', problem: '', solution: '', benefit: '', topic: '', ideaType: 'internal', ideaKind: 'idea', confidential: false, anonymous: false, challengeId: '',
  customValues: {}, teamName: '',
};

/** "/einreichen?art=problem" starts with a problem (R3-31). */
const initialKind = (): Form['ideaKind'] => (typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('art') === 'problem' ? 'problem' : 'idea');

// Guided submission in at most four steps (R1-12), with similar ideas (R1-19),
// confidential/anonymous (R1-14), delegated submission (R1-17) and boundary check (R1-18).
export function Submit() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { settings } = useSession();
  const [step, setStep] = useState(0);
  const [form, setForm] = useState<Form>(() => ({ ...EMPTY, ideaKind: initialKind() }));
  const [draftId, setDraftId] = useState<string | null>(id ?? null);
  const [onBehalf, setOnBehalf] = useState<UserRef | null>(null);
  const [delegate, setDelegate] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [similar, setSimilar] = useState<Similar[]>([]);
  const [joined, setJoined] = useState<Set<string>>(new Set());
  const [boundary, setBoundary] = useState<BoundaryMatch[] | null>(null);
  const [saved, setSaved] = useState(false);
  const [coach, setCoach] = useState(false);
  const [originalText, setOriginalText] = useState<string | null>(null);
  const { busy, error, run, setError } = useAction();
  const challenges = useLoad<{ id: string; title: string; active: boolean; acceptsIdeas?: boolean }[]>('/api/challenges');
  // Own fields and teams of the chosen challenge (R2-35).
  const challenge = useLoad<{ customFields: CustomField[]; teamsAllowed: boolean }>(form.challengeId ? `/api/challenges/${form.challengeId}` : null);
  const challengeFields = form.challengeId ? challenge.data?.customFields ?? [] : [];
  const teamsAllowed = !!form.challengeId && !!challenge.data?.teamsAllowed;
  const [isTeam, setIsTeam] = useState(false);
  const [teamMembers, setTeamMembers] = useState<UserRef[]>([]);
  const [member, setMember] = useState<UserRef | null>(null);

  useEffect(() => {
    if (!id) return;
    type Loaded = Omit<Form, 'customValues' | 'teamName'> & {
      status: string;
      challenge: { id: string } | null;
      challengeValues?: { id: string; value: string | number }[];
      teamName?: string | null;
      originalText?: string | null;
    };
    api.get<Loaded>(`/api/ideas/${id}`).then((d) => {
      if (d.status !== 'draft') return navigate(`/ideen/${id}`, { replace: true });
      const customValues = Object.fromEntries((d.challengeValues ?? []).map((v) => [v.id, String(v.value)]));
      setForm({ ...EMPTY, ...d, topic: d.topic ?? '', challengeId: d.challenge?.id ?? '', customValues, teamName: d.teamName ?? '' });
      setIsTeam(!!d.teamName);
      setOriginalText(d.originalText ?? null);
    });
  }, [id, navigate]);

  useEffect(() => {
    const text = `${form.title} ${form.problem}`.trim();
    if (text.length < 8) return setSimilar([]);
    const timer = setTimeout(() => {
      api
        .get<Similar[]>(`/api/ideas/similar?text=${encodeURIComponent(text)}${draftId ? `&exclude=${draftId}` : ''}`)
        .then(setSimilar)
        .catch(() => setSimilar([]));
    }, 400);
    return () => clearTimeout(timer);
  }, [form.title, form.problem, draftId]);

  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((f) => ({ ...f, [key]: value }));

  const payload = () => ({
    title: form.title,
    problem: form.problem,
    solution: form.solution,
    benefit: form.benefit,
    topic: form.topic || null,
    ideaType: form.ideaType,
    ideaKind: form.ideaKind,
    confidential: form.confidential,
    anonymous: form.anonymous,
    challengeId: form.challengeId || null,
    customValues: Object.fromEntries(challengeFields.filter((f) => form.customValues[f.id]?.trim()).map((f) => [f.id, form.customValues[f.id]])),
    teamName: teamsAllowed && isTeam && form.teamName.trim() ? form.teamName.trim() : null,
    ...(originalText ? { originalText } : {}),
  });
  const applyFields = (f: Partial<IdeaFields>) => setForm((cur) => ({ ...cur, ...f }));
  const appendTo = (key: 'problem' | 'solution', text: string) => {
    setForm((cur) => ({ ...cur, [key]: cur[key] ? `${cur[key]}\n${text}` : text }));
    setOriginalText((o) => (o ? `${o}\n\nSpracheingabe: ${text}` : `Spracheingabe: ${text}`));
  };

  const addTeamMembers = async (ideaId: string): Promise<boolean> => {
    if (!teamsAllowed || !isTeam) return true;
    for (const m of teamMembers) {
      if (!(await run(() => api.post(`/api/ideas/${ideaId}/coauthors`, { userId: m.id })))) return false;
    }
    return true;
  };

  const saveDraft = async (): Promise<string | undefined> => {
    if (form.title.trim().length < 3) {
      setError(new ApiError(400, t('submit.error.title')));
      return undefined;
    }
    if (draftId) {
      const ok = await run(() => api.patch(`/api/ideas/${draftId}`, payload()));
      return ok && (await addTeamMembers(draftId)) ? draftId : undefined;
    }
    const r = await run(() => api.post<{ id: string }>('/api/ideas', { ...payload(), onBehalfOf: delegate ? onBehalf?.id : undefined }));
    if (r) setDraftId(r.id);
    return r && (await addTeamMembers(r.id)) ? r.id : undefined;
  };

  const doSubmit = async (acknowledged: boolean) => {
    const ideaId = await saveDraft();
    if (!ideaId) return;
    const ok = await run(() => api.post(`/api/ideas/${ideaId}/submit`, { confirmNotReport: confirm, boundaryAcknowledged: acknowledged }));
    if (ok) navigate(`/ideen/${ideaId}`, { state: { submitted: true } });
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!confirm) return setError(new ApiError(400, t('submit.error.confirm')));
    // Check before anything is stored: if the user cancels, nothing is saved.
    const check = await run(() => api.post<{ matches: BoundaryMatch[] }>('/api/boundary-check', { text: `${form.title} ${form.problem} ${form.solution} ${form.benefit}` }));
    if (!check) return;
    if (check.matches.length) return setBoundary(check.matches);
    await doSubmit(false);
  };

  const join = async (s: Similar) => {
    if (await run(() => api.post(`/api/ideas/${s.id}/support`))) setJoined((j) => new Set(j).add(s.id));
  };

  const fieldsComplete = challengeFields.every((f) => !f.required || !!form.customValues[f.id]?.trim());
  const teamComplete = !teamsAllowed || !isTeam || form.teamName.trim().length > 0;
  const canNext = [
    form.title.trim().length >= 3 && form.problem.trim().length >= 10,
    (form.ideaKind === 'problem' || form.solution.trim().length >= 10) && form.benefit.trim().length >= 10,
    !!form.topic && (!delegate || !!onBehalf) && fieldsComplete && teamComplete,
    true,
  ][step];
  const setValue = (fieldId: string, value: string) => setForm((f) => ({ ...f, customValues: { ...f.customValues, [fieldId]: value } }));
  const activeChallenges = challenges.data?.filter((c) => (c.active && c.acceptsIdeas !== false) || c.id === form.challengeId) ?? [];
  const steps = [t('submit.step.problem'), t('submit.step.idea'), t('submit.step.classify'), t('submit.step.review')];

  return (
    <div className="layout-detail layout-submit">
      <div className="stack">
      {coach && (
        <Coach
          fields={{ title: form.title, problem: form.problem, solution: form.solution, benefit: form.benefit }}
          confidential={form.confidential}
          onFields={applyFields}
          onTranscript={setOriginalText}
          onClose={() => setCoach(false)}
        />
      )}
      <form className="card" onSubmit={submit} noValidate>
        <h1>{draftId ? t('submit.titleEdit') : t('submit.titleNew')}</h1>
        <ol className="steps" aria-label={t('submit.stepsLabel')}>
          {steps.map((s, i) => (
            <li key={s} className={i < step ? 'done' : i === step ? 'current' : ''} aria-current={i === step ? 'step' : undefined}>
              {i + 1}. {s}
            </li>
          ))}
        </ol>
        <ErrorBox error={error} />
        {saved && <div className="alert success" role="status">{t('submit.draftSaved')}</div>}

        {step === 0 && (
          <>
            {!coach && (
              <details className="assist">
                <summary>{t('submit.assist')}</summary>
                <p className="small muted">{t('submit.assistHint')}</p>
                <div className="row">
                  <button type="button" onClick={() => setCoach(true)}>💬 {t('submit.coach')}</button>
                  <PhotoSuggest confidential={form.confidential} onApply={applyFields} />
                  <VoiceButton confidential={form.confidential} onText={(text) => appendTo('problem', text)} />
                </div>
              </details>
            )}
            <fieldset>
              <legend>{t('submit.kind.legend')}</legend>
              <label className="check"><input type="radio" name="kind" checked={form.ideaKind === 'idea'} onChange={() => set('ideaKind', 'idea')} /> {t('submit.kind.idea')}</label>
              <label className="check"><input type="radio" name="kind" checked={form.ideaKind === 'problem'} onChange={() => set('ideaKind', 'problem')} /> {t('submit.kind.problem')}</label>
              {form.ideaKind === 'problem' && <p className="small muted">{t('submit.kind.problemHint')}</p>}
            </fieldset>
            <Field id="title" label={t('submit.field.title')} hint={t('submit.field.titleHint')}>
              <input id="title" type="text" value={form.title} onChange={(e) => set('title', e.target.value)} maxLength={140} required aria-describedby="title-hint" />
            </Field>
            <Field id="problem" label={t('submit.field.problem')} hint={t('submit.field.problemHint')}>
              <textarea id="problem" value={form.problem} onChange={(e) => set('problem', e.target.value)} required aria-describedby="problem-hint" />
            </Field>
          </>
        )}
        {step === 1 && (
          <>
            <Field id="solution" label={form.ideaKind === 'problem' ? t('submit.kind.solutionOptional') : t('submit.field.solution')}
              hint={form.ideaKind === 'problem' ? t('submit.kind.solutionOptionalHint') : t('submit.field.solutionHint')}>
              <textarea id="solution" value={form.solution} onChange={(e) => set('solution', e.target.value)} required={form.ideaKind !== 'problem'} aria-describedby="solution-hint" />
            </Field>
            <VoiceButton confidential={form.confidential} onText={(text) => appendTo('solution', text)} />
            <Field id="benefit" label={t('submit.field.benefit')} hint={t('submit.field.benefitHint')}>
              <textarea id="benefit" value={form.benefit} onChange={(e) => set('benefit', e.target.value)} required aria-describedby="benefit-hint" />
            </Field>
          </>
        )}
        {step === 2 && (
          <>
            <Field id="topic" label={t('submit.field.topic')}>
              <select id="topic" value={form.topic} onChange={(e) => set('topic', e.target.value)} required>
                <option value="">{t('submit.pleaseChoose')}</option>
                {settings.topics.map((topic) => <option key={topic}>{topic}</option>)}
              </select>
            </Field>
            <fieldset>
              <legend>{t('submit.type.legend')}</legend>
              <label className="check"><input type="radio" name="type" checked={form.ideaType === 'internal'} onChange={() => set('ideaType', 'internal')} /> {t('submit.type.internal')}</label>
              <label className="check"><input type="radio" name="type" checked={form.ideaType === 'product'} onChange={() => set('ideaType', 'product')} /> {t('submit.type.product')}</label>
            </fieldset>
            {activeChallenges.length > 0 && (
              <Field id="challenge" label={t('submit.field.challenge')}>
                <select id="challenge" value={form.challengeId} onChange={(e) => set('challengeId', e.target.value)}>
                  <option value="">{t('submit.challengeNone')}</option>
                  {activeChallenges.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
                </select>
              </Field>
            )}
            {challengeFields.length > 0 && (
              <fieldset>
                <legend>{t('submit.challengeFields')}</legend>
                {challengeFields.map((f) => (
                  <Field key={f.id} id={`cf-${f.id}`} label={`${f.label}${f.required ? t('submit.requiredSuffix') : ''}`}>
                    {f.type === 'select' ? (
                      <select id={`cf-${f.id}`} value={form.customValues[f.id] ?? ''} onChange={(e) => setValue(f.id, e.target.value)} required={f.required}>
                        <option value="">{t('submit.pleaseChoose')}</option>
                        {f.options.map((o) => <option key={o}>{o}</option>)}
                      </select>
                    ) : (
                      <input id={`cf-${f.id}`} type="text" inputMode={f.type === 'number' ? 'decimal' : undefined} value={form.customValues[f.id] ?? ''}
                        onChange={(e) => setValue(f.id, e.target.value)} required={f.required} />
                    )}
                  </Field>
                ))}
              </fieldset>
            )}
            <details className="more-options" open={form.confidential || form.anonymous || delegate || isTeam}>
              <summary>{t('submit.moreOptions')}</summary>
              {teamsAllowed && (
                <fieldset>
                  <legend>{t('submit.team.legend')}</legend>
                  <label className="check"><input type="checkbox" checked={isTeam} onChange={(e) => setIsTeam(e.target.checked)} /> {t('submit.team.asTeam')}</label>
                  {isTeam && (
                    <>
                      <Field id="team-name" label={t('submit.team.name')}>
                        <input id="team-name" type="text" maxLength={120} value={form.teamName} onChange={(e) => set('teamName', e.target.value)} required />
                      </Field>
                      <Field id="team-member" label={t('submit.team.members')} hint={t('submit.team.membersHint')}>
                        <UserPicker id="team-member" value={member} onChange={(u) => {
                          if (u && !teamMembers.some((m) => m.id === u.id)) setTeamMembers([...teamMembers, u]);
                          setMember(null);
                        }} />
                      </Field>
                      {teamMembers.length > 0 && (
                        <ul className="idea-list">
                          {teamMembers.map((m) => (
                            <li key={m.id} className="row spread">
                              {m.displayName}
                              <button type="button" className="link" onClick={() => setTeamMembers(teamMembers.filter((x) => x.id !== m.id))} aria-label={t('submit.team.removeLabel', { name: m.displayName })}>{t('submit.team.remove')}</button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </>
                  )}
                </fieldset>
              )}
              <fieldset>
                <legend>{t('submit.visibility.legend')}</legend>
                <label className="check"><input type="checkbox" checked={form.confidential} onChange={(e) => set('confidential', e.target.checked)} /> {t('submit.visibility.confidential')}</label>
                <label className="check"><input type="checkbox" checked={form.anonymous} onChange={(e) => set('anonymous', e.target.checked)} /> {t('submit.visibility.anonymous')}</label>
                <p className="hint">{t('submit.visibility.hint')}</p>
              </fieldset>
              {!draftId && (
                <fieldset>
                  <legend>{t('submit.behalf.legend')}</legend>
                  <label className="check"><input type="checkbox" checked={delegate} onChange={(e) => setDelegate(e.target.checked)} /> {t('submit.behalf.check')}</label>
                  {delegate && (
                    <Field id="behalf" label={t('submit.behalf.person')} hint={t('submit.behalf.hint')}>
                      <UserPicker id="behalf" value={onBehalf} onChange={setOnBehalf} />
                    </Field>
                  )}
                </fieldset>
              )}
            </details>
          </>
        )}
        {step === 3 && (
          <>
            <h2>{form.title}</h2>
            <dl>
              <dt><strong>{t('submit.review.problem')}</strong></dt><dd className="pre">{form.problem}</dd>
              <dt><strong>{t('submit.review.idea')}</strong></dt><dd className="pre">{form.solution}</dd>
              <dt><strong>{t('submit.review.benefit')}</strong></dt><dd className="pre">{form.benefit}</dd>
              <dt><strong>{t('submit.review.classification')}</strong></dt>
              <dd>
                {form.topic} · {form.ideaType === 'product' ? t('submit.review.product') : t('submit.review.internal')}
                {form.confidential && ` · ${t('submit.review.confidential')}`}
                {form.anonymous && ` · ${t('submit.review.anonymous')}`}
                {delegate && onBehalf && ` · ${t('submit.review.onBehalf', { name: onBehalf.displayName })}`}
              </dd>
              {teamsAllowed && isTeam && form.teamName && (
                <>
                  <dt><strong>{t('submit.review.team')}</strong></dt>
                  <dd>{form.teamName}{teamMembers.length > 0 && t('submit.review.teamWith', { names: teamMembers.map((m) => m.displayName).join(', ') })}</dd>
                </>
              )}
              {challengeFields.filter((f) => form.customValues[f.id]).map((f) => (
                <div key={f.id} style={{ display: 'contents' }}>
                  <dt><strong>{f.label}</strong></dt>
                  <dd>{form.customValues[f.id]}</dd>
                </div>
              ))}
            </dl>
            <label className="check alert info">
              <input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} />
              <span>
                {t('submit.confirm.before')}<strong>{t('submit.confirm.idea')}</strong>{t('submit.confirm.after')}<Link to="/hilfe">{t('submit.confirm.help')}</Link>{t('submit.confirm.end')}
              </span>
            </label>
            <p className="muted small">{t('submit.feedbackPromise', { days: settings.deadlines.gate1Workdays })}</p>
          </>
        )}

        <div className="row spread" style={{ marginTop: 16 }}>
          <div className="row">
            {step > 0 && <button type="button" onClick={() => setStep(step - 1)}>{t('submit.back')}</button>}
            <button
              type="button"
              disabled={busy}
              onClick={async () => {
                setSaved(false);
                if (await saveDraft()) setSaved(true);
              }}
            >
              {t('submit.saveDraft')}
            </button>
          </div>
          {step < 3 ? (
            <button type="button" className="primary" disabled={!canNext} onClick={() => setStep(step + 1)}>{t('submit.next')}</button>
          ) : (
            <button type="submit" className="primary" disabled={busy || !confirm}>{t('submit.send')}</button>
          )}
        </div>
      </form>
      </div>

      <aside className={similar.length ? 'card similar' : 'card similar empty'} aria-labelledby="h-similar" aria-live="polite">
        <h2 id="h-similar">{t('submit.similar.title')}</h2>
        {similar.length === 0 ? (
          <p className="muted small">{t('submit.similar.empty')}</p>
        ) : (
          <ul className="idea-list">
            {similar.map((s) => (
              <li key={s.id}>
                <Link to={`/ideen/${s.id}`} target="_blank">#{s.number} {s.title}</Link>
                <div className="row small muted">
                  <span>{STATUS_SHORT[s.status]}</span>
                  {joined.has(s.id) ? <span className="badge green">{t('submit.similar.joined')}</span> : <button type="button" className="link" onClick={() => join(s)}>{t('submit.similar.join')}</button>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </aside>

      {boundary && (
        <Dialog title={t('submit.boundary.title')} onClose={() => setBoundary(null)}>
          <p>{t('submit.boundary.intro')}</p>
          {boundary.map((m) => (
            <div key={m.category} className="alert warn">
              <strong>{m.label}</strong> <span className="small muted">{t('submit.boundary.detected', { keywords: m.keywords.join(', ') })}</span>
              <div>
                {m.channel ? (
                  <>
                    {t('submit.boundary.channel')} <strong>{m.channel.name}</strong>, {m.channel.contact}
                    {m.channel.url && <> · <a href={m.channel.url} target="_blank" rel="noreferrer">{t('submit.boundary.open')}</a></>}
                  </>
                ) : (
                  t('submit.boundary.noChannel')
                )}
              </div>
            </div>
          ))}
          <p className="small">{draftId ? t('submit.boundary.cancelDraft') : t('submit.boundary.cancelNew')}</p>
          <div className="row spread">
            <button type="button" onClick={() => navigate('/')}>{t('submit.boundary.cancel')}</button>
            <button
              type="button"
              className="primary"
              onClick={async () => {
                setBoundary(null);
                await doSubmit(true);
              }}
            >
              {t('submit.boundary.submitAnyway')}
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
