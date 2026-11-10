import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, api, type Criterion, type UserRef } from '../../api';
import { ErrorBox, Field, Loading, UserPicker, useAction, useLoad } from '../../components';
import {
  EXPERIMENT_OUTCOME,
  HORIZON,
  IMPACT_OUTCOME,
  OUTCOMES,
  SECTIONS,
  STORY_STATUS,
  formatDate,
  formatDateTime,
  formatEuro,
  formatNumber,
  parseNumber,
} from '../../labels';
import { useSession } from '../../session';
import { SuccessStoryDraft } from '../../ai/Extras';
import { intlLocale, t } from '../../i18n';

// Building blocks of the Steckbrief page (R2-47, ./Steckbrief.tsx): mentor and timebox (R2-01),
// dossier (R2-02), scorecard (R2-03), experiments (R2-06), impact review (R2-07) and success story
// (R2-37). Also the shared Gate 2 decision form (R1-30, R2-04, R2-05) and the mentor field of the triage form.

export interface Section {
  section: string;
  content: string;
  openPoints: string[];
  version: number;
  updatedAt: string | null;
  updatedBy: string | null;
  lock: { by: string | null; until: string; mine: boolean } | null;
}

export interface Overview {
  status: string;
  mentor: { id: string; name: string } | null;
  sponsor: { id: string; name: string } | null;
  timeboxUntil: string | null;
  timeboxRemainingWorkdays: number | null;
  estimates: { horizon: number | null; effortPersonDays: number | null; effortEuro: number | null; planBenefitEuro: number | null };
  delegation: { maxPersonDays: number; maxEuro: number; eligible: boolean };
  sections: Section[];
  lockMinutes: number;
  can: { editDossier: boolean; assignMentor: boolean; decide: boolean; decideDelegated: boolean };
}

export const AFTER_GATE2 = ['piloting', 'implementing', 'integrated', 'parked', 'completed'];

// ---------------------------------------------------------------- mentor field for the triage form (R2-01)

interface MentorLoad {
  active: number;
  warnAt: number;
  warning: string | null;
}

export function MentorField({
  mentor,
  onMentor,
  timeboxUntil,
  onTimebox,
  idPrefix = 'mentor',
}: {
  mentor: UserRef | null;
  onMentor: (u: UserRef | null) => void;
  timeboxUntil: string;
  onTimebox: (v: string) => void;
  idPrefix?: string;
}) {
  const { settings } = useSession();
  const [load, setLoad] = useState<MentorLoad | null>(null);
  useEffect(() => {
    setLoad(null);
    if (!mentor) return;
    api.get<MentorLoad>(`/api/mentors/${mentor.id}/load`).then(setLoad).catch(() => setLoad(null));
  }, [mentor]);
  return (
    <>
      <Field id={`${idPrefix}-person`} label={t('elaboration.mentor.label')} hint={t('elaboration.mentor.hint')}>
        <UserPicker id={`${idPrefix}-person`} value={mentor} onChange={onMentor} />
      </Field>
      {load && (
        <p className={load.warning ? 'alert warn' : 'small muted'} role={load.warning ? 'alert' : 'status'}>
          {load.warning ?? t('elaboration.mentor.load', { n: load.active })}
        </p>
      )}
      <Field id={`${idPrefix}-timebox`} label={t('elaboration.mentor.timeboxLabel')} hint={t('elaboration.mentor.timeboxHint', { weeks: settings.elaboration.timeboxWeeks })}>
        <input id={`${idPrefix}-timebox`} type="date" min={settings.today} value={timeboxUntil} onChange={(e) => onTimebox(e.target.value)} aria-describedby={`${idPrefix}-timebox-hint`} />
      </Field>
    </>
  );
}

export function defaultTimebox(today: string, weeks: number): string {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + weeks * 7);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------- Gate 2 decision form (R1-30, R2-04, R2-05)

export function DecisionForm({
  ideaId,
  meetingId,
  delegated,
  onDone,
  idPrefix = 'dec',
}: {
  ideaId: string;
  meetingId?: string;
  delegated?: boolean;
  onDone: () => void;
  idPrefix?: string;
}) {
  const { settings } = useSession();
  const [outcome, setOutcome] = useState('implement');
  const [reason, setReason] = useState('');
  const [owner, setOwner] = useState<UserRef | null>(null);
  const [sponsor, setSponsor] = useState<UserRef | null>(null);
  const [targetDate, setTargetDate] = useState('');
  const [resubmitOn, setResubmitOn] = useState('');
  const { busy, error, run } = useAction();
  const needsOwner = ['implement', 'pilot', 'integrate'].includes(outcome);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const body: Record<string, unknown> = { outcome, reason };
    if (needsOwner) Object.assign(body, { ownerId: owner?.id, targetDate, sponsorId: sponsor?.id });
    if (outcome === 'park') body.resubmitOn = resubmitOn;
    const url = meetingId ? `/api/meetings/${meetingId}/decisions/${ideaId}` : `/api/ideas/${ideaId}/decision`;
    if (await run(() => api.post(url, body))) onDone();
  };
  const maxPark = new Date(`${settings.today}T12:00:00`);
  maxPark.setMonth(maxPark.getMonth() + settings.deadlines.maxParkMonths);
  return (
    <form onSubmit={submit}>
      <ErrorBox error={error} />
      {delegated && (
        <p className="alert info">
          {t('elaboration.decision.delegated', { days: settings.thresholds.delegationMaxPersonDays, euro: formatEuro(settings.thresholds.delegationMaxEuro) })}
        </p>
      )}
      <fieldset>
        <legend>{t('elaboration.decision.outcome')}</legend>
        {Object.entries(OUTCOMES).map(([k, v]) => (
          <label key={k} className="check">
            <input type="radio" name={`${idPrefix}-outcome`} checked={outcome === k} onChange={() => setOutcome(k)} /> {v}
          </label>
        ))}
      </fieldset>
      {needsOwner && (
        <>
          <Field id={`${idPrefix}-owner`} label={t('elaboration.decision.owner')}>
            <UserPicker id={`${idPrefix}-owner`} value={owner} onChange={setOwner} />
          </Field>
          <Field id={`${idPrefix}-target`} label={t('elaboration.decision.targetDate')}>
            <input id={`${idPrefix}-target`} type="date" min={settings.today} value={targetDate} onChange={(e) => setTargetDate(e.target.value)} required />
          </Field>
          <Field id={`${idPrefix}-sponsor`} label={t('elaboration.decision.sponsor')} hint={t('elaboration.decision.sponsorHint')}>
            <UserPicker id={`${idPrefix}-sponsor`} value={sponsor} onChange={setSponsor} />
          </Field>
        </>
      )}
      {outcome === 'park' && (
        <Field id={`${idPrefix}-resubmit`} label={t('elaboration.decision.resubmit')} hint={t('elaboration.decision.resubmitHint', { n: settings.deadlines.maxParkMonths })}>
          <input id={`${idPrefix}-resubmit`} type="date" min={settings.today} max={maxPark.toISOString().slice(0, 10)} value={resubmitOn} onChange={(e) => setResubmitOn(e.target.value)} required />
        </Field>
      )}
      <Field id={`${idPrefix}-reason`} label={t('elaboration.decision.reason')} hint={t('elaboration.decision.reasonHint')}>
        <textarea id={`${idPrefix}-reason`} value={reason} onChange={(e) => setReason(e.target.value)} required />
      </Field>
      <button className="primary" disabled={busy}>{t('elaboration.decision.save')}</button>
    </form>
  );
}

// ---------------------------------------------------------------- challenge values (R2-35)

export function ChallengeValues({ values, teamName }: { values: { id: string; label: string; value: string | number }[]; teamName: string | null }) {
  if (!values.length && !teamName) return null;
  return (
    <dl className="facts">
      {teamName && (
        <>
          <dt>{t('elaboration.challenge.team')}</dt>
          <dd>{teamName}</dd>
        </>
      )}
      {values.map((v) => (
        <div key={v.id} style={{ display: 'contents' }}>
          <dt>{v.label}</dt>
          <dd>{typeof v.value === 'number' ? formatNumber(v.value) : v.value}</dd>
        </div>
      ))}
    </dl>
  );
}

// ---------------------------------------------------------------- key facts: mentor, timebox, estimates

export function MentorCard({ ideaId, data, onDone }: { ideaId: string; data: Overview; onDone: () => void }) {
  const { settings } = useSession();
  const [editing, setEditing] = useState(false);
  const [mentor, setMentor] = useState<UserRef | null>(null);
  const [timebox, setTimebox] = useState(data.timeboxUntil ?? defaultTimebox(settings.today, settings.elaboration.timeboxWeeks));
  const [estimating, setEstimating] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const { busy, error, run } = useAction();
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const r = await run(() => api.post<{ ok: boolean; warning: string | null }>(`/api/ideas/${ideaId}/mentor`, { mentorId: mentor?.id ?? data.mentor?.id ?? null, timeboxUntil: timebox }));
    if (r) {
      setEditing(false);
      setSaved(r.warning ? t('elaboration.card.savedWarning', { warning: r.warning }) : t('elaboration.card.saved'));
      onDone();
    }
  };
  const e = data.estimates;
  const box = data.timeboxRemainingWorkdays;
  if (!data.mentor && !data.timeboxUntil && !data.can.assignMentor && e.effortPersonDays == null && e.planBenefitEuro == null && e.horizon == null) return null;
  return (
    <section className="card" aria-labelledby="h-elab">
      <h2 id="h-elab">{t('elaboration.card.title')}</h2>
      {saved && <p className="alert success" role="status">{saved}</p>}
      <ErrorBox error={error} />
      <dl className="facts">
        <dt>{t('elaboration.card.mentor')}</dt>
        <dd>{data.mentor?.name ?? t('elaboration.card.noMentor')}</dd>
        {data.timeboxUntil && (
          <>
            <dt>{t('elaboration.card.timebox')}</dt>
            <dd>
              {t('elaboration.card.until', { date: formatDate(data.timeboxUntil) })}
              {data.status === 'elaboration' && box != null && (
                <span className={`light ${box < 0 ? 'red' : box <= settings.deadlines.reminderWorkdaysBefore ? 'yellow' : 'green'}`} style={{ marginLeft: 8 }}>
                  {box >= 0 ? t('elaboration.card.remaining', { n: box }) : t('elaboration.card.overdue', { n: -box })}
                </span>
              )}
            </dd>
          </>
        )}
        {data.sponsor && (
          <>
            <dt>{t('elaboration.card.sponsor')}</dt>
            <dd>{data.sponsor.name}</dd>
          </>
        )}
        <dt>{t('elaboration.card.horizon')}</dt>
        <dd>{e.horizon ? HORIZON[e.horizon] : '–'}</dd>
        <dt>{t('elaboration.card.effort')}</dt>
        <dd>
          {e.effortPersonDays != null ? t('elaboration.card.personDays', { n: formatNumber(e.effortPersonDays) }) : '–'} · {formatEuro(e.effortEuro)}
          {data.delegation.eligible && <span className="badge" style={{ marginLeft: 8 }}>{t('elaboration.card.delegable')}</span>}
        </dd>
        <dt>{t('elaboration.card.planBenefit')}</dt>
        <dd>{t('elaboration.card.perYear', { euro: formatEuro(e.planBenefitEuro) })}</dd>
      </dl>
      <div className="row">
        {data.can.assignMentor && !editing && <button type="button" onClick={() => setEditing(true)}>{t('elaboration.card.change')}</button>}
        {data.can.editDossier && !estimating && <button type="button" onClick={() => setEstimating(true)}>{t('elaboration.card.editEstimates')}</button>}
      </div>
      {editing && (
        <form onSubmit={save} style={{ marginTop: 12 }}>
          <MentorField mentor={mentor ?? (data.mentor ? { id: data.mentor.id, displayName: data.mentor.name, orgUnit: null } : null)} onMentor={setMentor} timeboxUntil={timebox} onTimebox={setTimebox} idPrefix="re-mentor" />
          <div className="row">
            <button type="button" onClick={() => setEditing(false)}>{t('elaboration.cancel')}</button>
            <button className="primary" disabled={busy}>{t('elaboration.save')}</button>
          </div>
        </form>
      )}
      {estimating && <EstimatesForm ideaId={ideaId} data={data} onClose={() => setEstimating(false)} onDone={onDone} />}
    </section>
  );
}

function EstimatesForm({ ideaId, data, onClose, onDone }: { ideaId: string; data: Overview; onClose: () => void; onDone: () => void }) {
  const e = data.estimates;
  const str = (v: number | null) => (v == null ? '' : String(v).replace('.', ','));
  const [form, setForm] = useState({ horizon: e.horizon ? String(e.horizon) : '', pd: str(e.effortPersonDays), euro: str(e.effortEuro), plan: str(e.planBenefitEuro) });
  const { busy, error, run, setError } = useAction();
  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    const values = { effortPersonDays: parseNumber(form.pd), effortEuro: parseNumber(form.euro), planBenefitEuro: parseNumber(form.plan) };
    if (Object.values(values).some((v) => v !== null && Number.isNaN(v))) return setError(new ApiError(400, t('elaboration.estimates.numbersExample')));
    if (await run(() => api.patch(`/api/ideas/${ideaId}/estimates`, { ...values, horizon: form.horizon ? Number(form.horizon) : null }))) {
      onClose();
      onDone();
    }
  };
  return (
    <form onSubmit={submit} style={{ marginTop: 12 }}>
      <h3>{t('elaboration.estimates.title')}</h3>
      <ErrorBox error={error} />
      <div className="grid grid-2">
        <Field id="est-horizon" label={t('elaboration.estimates.horizon')}>
          <select id="est-horizon" value={form.horizon} onChange={(ev) => setForm({ ...form, horizon: ev.target.value })}>
            <option value="">{t('elaboration.estimates.open')}</option>
            {[1, 2, 3].map((h) => <option key={h} value={h}>{HORIZON[h]}</option>)}
          </select>
        </Field>
        <Field id="est-pd" label={t('elaboration.estimates.pd')}>
          <input id="est-pd" type="text" inputMode="decimal" value={form.pd} onChange={(ev) => setForm({ ...form, pd: ev.target.value })} />
        </Field>
        <Field id="est-euro" label={t('elaboration.estimates.euro')}>
          <input id="est-euro" type="text" inputMode="decimal" value={form.euro} onChange={(ev) => setForm({ ...form, euro: ev.target.value })} />
        </Field>
        <Field id="est-plan" label={t('elaboration.estimates.plan')}>
          <input id="est-plan" type="text" inputMode="decimal" value={form.plan} onChange={(ev) => setForm({ ...form, plan: ev.target.value })} />
        </Field>
      </div>
      <p className="hint">
        {t('elaboration.estimates.delegation', { days: formatNumber(data.delegation.maxPersonDays), euro: formatEuro(data.delegation.maxEuro) })}
      </p>
      <div className="row">
        <button type="button" onClick={onClose}>{t('elaboration.cancel')}</button>
        <button className="primary" disabled={busy}>{t('elaboration.save')}</button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------- dossier (R2-02)

export function Dossier({ ideaId, data, onDone }: { ideaId: string; data: Overview; onDone: () => void }) {
  return (
    <section className="card" aria-labelledby="h-dossier">
      <h2 id="h-dossier">{t('elaboration.dossier.title')}</h2>
      {data.can.editDossier && (
        <p className="small muted">
          {t('elaboration.dossier.lockInfo', { n: data.lockMinutes })}
        </p>
      )}
      {data.sections.map((s) => (
        <DossierSection key={s.section} ideaId={ideaId} s={s} canEdit={data.can.editDossier} onDone={onDone} />
      ))}
    </section>
  );
}

interface HistoryEntry {
  version: number;
  content: string;
  source: 'human' | 'ai';
  changedAt: string;
  changedBy: string | null;
}

function DossierSection({ ideaId, s, canEdit, onDone }: { ideaId: string; s: Section; canEdit: boolean; onDone: () => void }) {
  const [editing, setEditing] = useState<{ version: number; content: string; openPoints: string } | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const history = useLoad<HistoryEntry[]>(showHistory ? `/api/ideas/${ideaId}/dossier/${s.section}/history` : null);
  const { busy, error, run } = useAction();
  const label = SECTIONS[s.section] ?? s.section;
  const lockedByOther = !!s.lock && !s.lock.mine;
  const id = `dossier-${s.section}`;

  const start = async () => {
    setMessage(null);
    const r = await run(() => api.post<{ version: number; content: string; openPoints: string[] }>(`/api/ideas/${ideaId}/dossier/${s.section}/lock`));
    if (r) setEditing({ version: r.version, content: r.content, openPoints: r.openPoints.join('\n') });
    else onDone();
  };
  const cancel = async () => {
    await api.del(`/api/ideas/${ideaId}/dossier/${s.section}/lock`).catch(() => undefined);
    setEditing(null);
    onDone();
  };
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    const body = { content: editing.content, expectedVersion: editing.version, openPoints: editing.openPoints.split('\n').map((x) => x.trim()).filter(Boolean) };
    const r = await run(() => api.put<{ version: number }>(`/api/ideas/${ideaId}/dossier/${s.section}`, body));
    if (r) {
      setEditing(null);
      setMessage(t('elaboration.dossier.saved', { label, version: r.version }));
      onDone();
      if (showHistory) void history.reload();
    }
  };

  return (
    <div className="dossier-section" aria-labelledby={`${id}-h`}>
      <div className="row spread">
        <h3 id={`${id}-h`}>{label}</h3>
        <div className="row small">
          {s.lock && (
            <span className="badge yellow">
              {t(s.lock.mine ? 'elaboration.dossier.lockMine' : 'elaboration.dossier.lockOther', { name: s.lock.by ?? t('elaboration.dossier.someone'), time: new Date(s.lock.until).toLocaleTimeString(intlLocale(), { hour: '2-digit', minute: '2-digit' }) })}
            </span>
          )}
          {canEdit && !editing && (
            <button type="button" className="link" onClick={start} disabled={busy || lockedByOther} aria-label={t('elaboration.dossier.editAria', { label })}>
              {t('elaboration.dossier.edit')}
            </button>
          )}
          {s.version > 0 && (
            <button type="button" className="link" aria-expanded={showHistory} aria-controls={`${id}-history`} onClick={() => setShowHistory(!showHistory)}>
              {t('elaboration.dossier.history')}
            </button>
          )}
        </div>
      </div>
      <ErrorBox error={error} />
      {message && <p className="alert success small" role="status">{message}</p>}
      {editing ? (
        <form onSubmit={save}>
          <Field id={`${id}-content`} label={t('elaboration.dossier.textLabel', { label })}>
            <textarea id={`${id}-content`} rows={6} value={editing.content} onChange={(e) => setEditing({ ...editing, content: e.target.value })} />
          </Field>
          <Field id={`${id}-open`} label={t('elaboration.dossier.openLabel')} hint={t('elaboration.dossier.openHint')}>
            <textarea id={`${id}-open`} rows={2} value={editing.openPoints} onChange={(e) => setEditing({ ...editing, openPoints: e.target.value })} aria-describedby={`${id}-open-hint`} />
          </Field>
          <div className="row">
            <button type="button" onClick={cancel}>{t('elaboration.cancel')}</button>
            <button className="primary" disabled={busy}>{t('elaboration.save')}</button>
          </div>
        </form>
      ) : (
        <>
          <p className={`pre ${s.content ? '' : 'muted'}`}>{s.content || t('elaboration.dossier.empty')}</p>
          {s.openPoints.length > 0 && (
            <div className="small">
              <strong>{t('elaboration.dossier.openPoints')}</strong>
              <ul>{s.openPoints.map((p, i) => <li key={i}>{p}</li>)}</ul>
            </div>
          )}
          {s.updatedAt && <p className="small muted">{t('elaboration.dossier.versionMeta', { version: s.version, by: s.updatedBy ?? t('elaboration.dossier.ai'), date: formatDateTime(s.updatedAt) })}</p>}
        </>
      )}
      {showHistory && (
        <div id={`${id}-history`}>
          {history.loading && !history.data ? <Loading /> : (
            <ol className="timeline">
              {(history.data ?? []).map((h) => (
                <li key={h.version}>
                  <details>
                    <summary>
                      {t('elaboration.dossier.historyMeta', { version: h.version, date: formatDateTime(h.changedAt), by: h.source === 'ai' ? t('elaboration.dossier.aiDraft') : h.changedBy ?? t('elaboration.dossier.unknown') })}
                    </summary>
                    <p className="pre small">{h.content || t('elaboration.dossier.blank')}</p>
                  </details>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- scorecard (R2-03) and jury form (R2-35)

/** Weighted average on the 1-5 scale, as computed by the server. */
export function weightedTotal(criteria: Pick<Criterion, 'id' | 'weight'>[], scores: Record<string, number>): number | null {
  if (criteria.some((c) => !scores[c.id])) return null;
  const weight = criteria.reduce((n, c) => n + c.weight, 0);
  return Math.round((criteria.reduce((n, c) => n + c.weight * scores[c.id], 0) / weight) * 100) / 100;
}

export function ScoreForm({
  criteria,
  initial,
  onSubmit,
  idPrefix,
  submitLabel = t('elaboration.score.save'),
}: {
  criteria: Criterion[];
  initial: { scores: Record<string, number>; comment: string | null } | null;
  onSubmit: (scores: Record<string, number>, comment: string | null) => Promise<boolean>;
  idPrefix: string;
  submitLabel?: string;
}) {
  const [scores, setScores] = useState<Record<string, number>>(initial?.scores ?? {});
  const [comment, setComment] = useState(initial?.comment ?? '');
  const [saved, setSaved] = useState(false);
  const total = weightedTotal(criteria, scores);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaved(false);
    if (await onSubmit(scores, comment || null)) setSaved(true);
  };
  return (
    <form onSubmit={submit}>
      {criteria.map((c) => (
        <fieldset key={c.id} className="score">
          <legend>
            {c.label} <span className="muted small">({c.weight} %)</span>
          </legend>
          {c.question && <p className="small muted" style={{ margin: '0 0 6px' }}>{c.question}</p>}
          <div className="score-scale">
            {[1, 2, 3, 4, 5].map((n) => (
              <label key={n} className="score-option">
                <input type="radio" name={`${idPrefix}-${c.id}`} value={n} checked={scores[c.id] === n} onChange={() => { setSaved(false); setScores({ ...scores, [c.id]: n }); }} />
                <span>{n}</span>
              </label>
            ))}
          </div>
          {(c.anchors?.[1] || c.anchors?.[3] || c.anchors?.[5]) && (
            <ul className="anchors small muted">
              {([1, 3, 5] as const).map((n) => c.anchors[n] && <li key={n}><strong>{n}:</strong> {c.anchors[n]}</li>)}
            </ul>
          )}
        </fieldset>
      ))}
      <Field id={`${idPrefix}-comment`} label={t('elaboration.score.comment')}>
        <input id={`${idPrefix}-comment`} type="text" value={comment} onChange={(e) => setComment(e.target.value)} />
      </Field>
      <div className="row">
        <span aria-live="polite">{t('elaboration.score.total')} <strong>{formatNumber(total)}</strong> {t('elaboration.score.of5')}</span>
        <button className="primary" disabled={total == null}>{submitLabel}</button>
      </div>
      {saved && <p className="alert success small" role="status">{t('elaboration.score.saved')}</p>}
    </form>
  );
}

interface ScorecardView {
  criteria: Criterion[];
  mine: { scores: Record<string, number>; total: number; comment: string | null } | null;
  average: { total: number; count: number; perCriterion: Record<string, number | null> } | null;
  ratings: { name: string; total: number; scores: Record<string, number>; comment: string | null }[] | null;
  can: { rate: boolean };
}

export function Scorecard({ ideaId }: { ideaId: string }) {
  const { data, reload } = useLoad<ScorecardView>(`/api/ideas/${ideaId}/scorecard`);
  const { error, run } = useAction();
  const [open, setOpen] = useState(false);
  if (!data || (!data.can.rate && !data.average)) return null;
  return (
    <section className="card" aria-labelledby="h-score">
      <h2 id="h-score">{t('elaboration.scorecard.title')}</h2>
      {data.average ? (
        <>
          <p>
            {t('elaboration.scorecard.avgBefore')} <strong className="kpi-inline">{formatNumber(data.average.total)}</strong> {t('elaboration.scorecard.avgAfter', { n: data.average.count })}
          </p>
          <div className="table-wrap" tabIndex={0}><table>
            <caption className="sr-only">{t('elaboration.scorecard.caption')}</caption>
            <thead><tr><th scope="col">{t('elaboration.scorecard.criterion')}</th><th scope="col">{t('elaboration.scorecard.weight')}</th><th scope="col">{t('elaboration.scorecard.avg')}</th></tr></thead>
            <tbody>
              {data.criteria.map((c) => (
                <tr key={c.id}><th scope="row">{c.label}</th><td>{c.weight} %</td><td>{formatNumber(data.average!.perCriterion[c.id])}</td></tr>
              ))}
            </tbody>
          </table></div>
        </>
      ) : (
        <p className="muted">{t('elaboration.scorecard.none')}</p>
      )}
      {data.ratings && data.ratings.length > 0 && (
        <details style={{ marginTop: 8 }}>
          <summary>{t('elaboration.scorecard.individual')}</summary>
          <ul className="idea-list small">
            {data.ratings.map((r, i) => (
              <li key={i}>
                {r.name}: {formatNumber(r.total)}
                {r.comment && <span className="muted"> – {r.comment}</span>}
              </li>
            ))}
          </ul>
        </details>
      )}
      {data.can.rate && (
        <>
          <button type="button" style={{ marginTop: 10 }} aria-expanded={open} onClick={() => setOpen(!open)}>
            {data.mine ? t('elaboration.scorecard.change') : t('elaboration.scorecard.rate')}
          </button>
          {open && (
            <div style={{ marginTop: 10 }}>
              <ErrorBox error={error} />
              <ScoreForm
                idPrefix="gate2"
                criteria={data.criteria}
                initial={data.mine}
                onSubmit={async (scores, comment) => {
                  const r = await run(() => api.put(`/api/ideas/${ideaId}/scorecard`, { scores, comment }));
                  if (r) void reload();
                  return !!r;
                }}
              />
            </div>
          )}
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- experiments (R2-06)

interface Experiment {
  id: string;
  hypothesis: string;
  smallestTest: string;
  metric: string;
  successCriteria: string;
  startsOn: string;
  endsOn: string;
  status: 'running' | 'done';
  outcome: string | null;
  result: string | null;
  createdBy: string | null;
}

export function Experiments({ ideaId, onDone }: { ideaId: string; onDone: () => void }) {
  const { settings } = useSession();
  const { data, reload } = useLoad<{ items: Experiment[]; can: { manage: boolean } }>(`/api/ideas/${ideaId}/experiments`);
  const [creating, setCreating] = useState(false);
  const empty = { hypothesis: '', smallestTest: '', metric: '', successCriteria: '', startsOn: settings.today, endsOn: '' };
  const [form, setForm] = useState(empty);
  const { busy, error, run } = useAction();
  if (!data || (!data.can.manage && !data.items.length)) return null;
  const create = async (e: FormEvent) => {
    e.preventDefault();
    if (await run(() => api.post(`/api/ideas/${ideaId}/experiments`, form))) {
      setCreating(false);
      setForm(empty);
      void reload();
    }
  };
  return (
    <section className="card" aria-labelledby="h-exp">
      <h2 id="h-exp">{t('elaboration.exp.title')}</h2>
      {data.items.length === 0 && <p className="muted">{t('elaboration.exp.none')}</p>}
      <ul className="idea-list">
        {data.items.map((x) => (
          <ExperimentItem key={x.id} ideaId={ideaId} x={x} canManage={data.can.manage} onDone={() => { void reload(); onDone(); }} />
        ))}
      </ul>
      {data.can.manage && <p className="small muted">{t('elaboration.exp.aiHint')}</p>}
      {data.can.manage && !creating && <button type="button" onClick={() => setCreating(true)}>{t('elaboration.exp.create')}</button>}
      {creating && (
        <form onSubmit={create} style={{ marginTop: 12 }}>
          <h3>{t('elaboration.exp.new')}</h3>
          <ErrorBox error={error} />
          <Field id="exp-hyp" label={t('elaboration.exp.hypothesis')} hint={t('elaboration.exp.hypothesisHint')}>
            <textarea id="exp-hyp" value={form.hypothesis} onChange={(e) => setForm({ ...form, hypothesis: e.target.value })} required aria-describedby="exp-hyp-hint" />
          </Field>
          <Field id="exp-test" label={t('elaboration.exp.smallestTest')}>
            <textarea id="exp-test" value={form.smallestTest} onChange={(e) => setForm({ ...form, smallestTest: e.target.value })} />
          </Field>
          <div className="grid grid-2">
            <Field id="exp-metric" label={t('elaboration.exp.metric')}>
              <input id="exp-metric" type="text" value={form.metric} onChange={(e) => setForm({ ...form, metric: e.target.value })} required />
            </Field>
            <Field id="exp-success" label={t('elaboration.exp.successCriteria')}>
              <input id="exp-success" type="text" value={form.successCriteria} onChange={(e) => setForm({ ...form, successCriteria: e.target.value })} />
            </Field>
            <Field id="exp-start" label={t('elaboration.exp.start')}>
              <input id="exp-start" type="date" value={form.startsOn} onChange={(e) => setForm({ ...form, startsOn: e.target.value })} required />
            </Field>
            <Field id="exp-end" label={t('elaboration.exp.end')} hint={t('elaboration.exp.endHint', { n: settings.elaboration.experimentReminderWorkdays })}>
              <input id="exp-end" type="date" min={form.startsOn} value={form.endsOn} onChange={(e) => setForm({ ...form, endsOn: e.target.value })} required />
            </Field>
          </div>
          <div className="row">
            <button type="button" onClick={() => setCreating(false)}>{t('elaboration.cancel')}</button>
            <button className="primary" disabled={busy}>{t('elaboration.exp.submit')}</button>
          </div>
        </form>
      )}
    </section>
  );
}

function ExperimentItem({ ideaId, x, canManage, onDone }: { ideaId: string; x: Experiment; canManage: boolean; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [outcome, setOutcome] = useState('confirmed');
  const [result, setResult] = useState('');
  const { busy, error, run } = useAction();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (await run(() => api.post(`/api/ideas/${ideaId}/experiments/${x.id}/result`, { outcome, result }))) {
      setOpen(false);
      onDone();
    }
  };
  return (
    <li>
      <div className="row spread">
        <strong>{x.hypothesis}</strong>
        <span className={`badge ${x.status === 'done' ? 'green' : 'accent'}`}>{x.status === 'done' ? EXPERIMENT_OUTCOME[x.outcome ?? ''] : t('elaboration.exp.running')}</span>
      </div>
      <div className="small muted">
        {t('elaboration.exp.meta', { start: formatDate(x.startsOn), end: formatDate(x.endsOn), metric: x.metric })}
        {x.successCriteria && t('elaboration.exp.success', { criteria: x.successCriteria })}
      </div>
      {x.smallestTest && <p className="small pre" style={{ margin: '4px 0' }}>{x.smallestTest}</p>}
      {x.result && <p className="small pre" style={{ margin: '4px 0' }}><strong>{t('elaboration.exp.resultLabel')}</strong> {x.result}</p>}
      {canManage && x.status === 'running' && !open && <button type="button" className="link" onClick={() => setOpen(true)}>{t('elaboration.exp.record')}</button>}
      {open && (
        <form onSubmit={submit}>
          <ErrorBox error={error} />
          <fieldset>
            <legend>{t('elaboration.exp.outcome')}</legend>
            {Object.entries(EXPERIMENT_OUTCOME).map(([k, v]) => (
              <label key={k} className="check"><input type="radio" name={`exp-outcome-${x.id}`} checked={outcome === k} onChange={() => setOutcome(k)} /> {v}</label>
            ))}
          </fieldset>
          <Field id={`exp-result-${x.id}`} label={t('elaboration.exp.resultQuestion')} hint={t('elaboration.exp.resultHint')}>
            <textarea id={`exp-result-${x.id}`} value={result} onChange={(e) => setResult(e.target.value)} required />
          </Field>
          <div className="row">
            <button type="button" onClick={() => setOpen(false)}>{t('elaboration.cancel')}</button>
            <button className="primary" disabled={busy}>{t('elaboration.exp.saveResult')}</button>
          </div>
        </form>
      )}
    </li>
  );
}

// ---------------------------------------------------------------- impact review at Gate 3 (R2-07)

interface Review {
  dueOn: string;
  due: boolean;
  reviewerName: string | null;
  sponsorName: string | null;
  planValue: number | null;
  actualValue: number | null;
  outcome: string | null;
  notes: string | null;
  doneAt: string | null;
  confirmedAt: string | null;
  confirmedBy: string | null;
  can: { record: boolean; confirm: boolean };
}

export function ImpactReview({ ideaId, onDone }: { ideaId: string; onDone: () => void }) {
  const { data, reload } = useLoad<{ review: Review | null }>(`/api/ideas/${ideaId}/impact-review`);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ plan: '', actual: '', outcome: 'close', notes: '' });
  const { busy, error, run, setError } = useAction();
  const r = data?.review;
  if (!r) return null;
  const startEdit = () => {
    const str = (v: number | null) => (v == null ? '' : String(v).replace('.', ','));
    setForm({ plan: str(r.planValue), actual: str(r.actualValue), outcome: r.outcome ?? 'close', notes: r.notes ?? '' });
    setEditing(true);
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const planValue = parseNumber(form.plan);
    const actualValue = parseNumber(form.actual);
    if (Number.isNaN(planValue) || Number.isNaN(actualValue)) return setError(new ApiError(400, t('elaboration.impact.numbers')));
    if (await run(() => api.put(`/api/ideas/${ideaId}/impact-review`, { planValue, actualValue, outcome: form.outcome, notes: form.notes }))) {
      setEditing(false);
      void reload();
      onDone();
    }
  };
  const confirm = async () => {
    if (await run(() => api.post(`/api/ideas/${ideaId}/impact-review/confirm`))) {
      void reload();
      onDone();
    }
  };
  return (
    <section className="card" aria-labelledby="h-impact">
      <h2 id="h-impact">{t('elaboration.impact.title')}</h2>
      <ErrorBox error={error} />
      <p>
        {t('elaboration.impact.meta', { date: formatDate(r.dueOn), reviewer: r.reviewerName ?? t('elaboration.impact.triageTeam'), confirmer: r.sponsorName ?? t('elaboration.impact.committee') })}
      </p>
      {r.doneAt ? (
        <dl className="facts">
          <dt>{t('elaboration.impact.plan')}</dt><dd>{formatEuro(r.planValue)}</dd>
          <dt>{t('elaboration.impact.actual')}</dt><dd>{formatEuro(r.actualValue)}</dd>
          <dt>{t('elaboration.impact.recommendation')}</dt><dd>{IMPACT_OUTCOME[r.outcome ?? '']}</dd>
          <dt>{t('elaboration.impact.reason')}</dt><dd className="pre">{r.notes}</dd>
          <dt>{t('elaboration.impact.status')}</dt><dd>{r.confirmedAt ? t('elaboration.impact.confirmed', { name: r.confirmedBy ?? '–', date: formatDate(r.confirmedAt) }) : t('elaboration.impact.waiting')}</dd>
        </dl>
      ) : (
        <p className="muted">{r.due ? t('elaboration.impact.due') : t('elaboration.impact.notDue')}</p>
      )}
      <div className="row">
        {r.can.record && !editing && <button type="button" onClick={startEdit}>{r.doneAt ? t('elaboration.impact.change') : t('elaboration.impact.record')}</button>}
        {r.can.confirm && <button type="button" className="primary" disabled={busy} onClick={confirm}>{t('elaboration.impact.confirm')}</button>}
      </div>
      {editing && (
        <form onSubmit={submit} style={{ marginTop: 12 }}>
          <div className="grid grid-2">
            <Field id="ir-plan" label={t('elaboration.impact.planLabel')}>
              <input id="ir-plan" type="text" inputMode="decimal" value={form.plan} onChange={(e) => setForm({ ...form, plan: e.target.value })} />
            </Field>
            <Field id="ir-actual" label={t('elaboration.impact.actualLabel')}>
              <input id="ir-actual" type="text" inputMode="decimal" value={form.actual} onChange={(e) => setForm({ ...form, actual: e.target.value })} />
            </Field>
          </div>
          <fieldset>
            <legend>{t('elaboration.impact.recommendation')}</legend>
            {Object.entries(IMPACT_OUTCOME).map(([k, v]) => (
              <label key={k} className="check"><input type="radio" name="ir-outcome" checked={form.outcome === k} onChange={() => setForm({ ...form, outcome: k })} /> {v}</label>
            ))}
          </fieldset>
          <Field id="ir-notes" label={t('elaboration.impact.reason')} hint={t('elaboration.impact.reasonHint')}>
            <textarea id="ir-notes" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} required />
          </Field>
          <div className="row">
            <button type="button" onClick={() => setEditing(false)}>{t('elaboration.cancel')}</button>
            <button className="primary" disabled={busy}>{t('elaboration.save')}</button>
          </div>
        </form>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- success story (R2-37)

interface StoryView {
  story: { id: string; title: string; body: string; status: string; nameAuthors: boolean; publishedAt: string | null } | null;
  can: { edit: boolean; send: boolean; approve: boolean };
}

export function SuccessStory({ ideaId }: { ideaId: string }) {
  const { data, reload } = useLoad<StoryView>(`/api/ideas/${ideaId}/success-story`);
  const [form, setForm] = useState<{ title: string; body: string } | null>(null);
  const [nameAuthors, setNameAuthors] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const { busy, error, run } = useAction();
  if (!data || (!data.story && !data.can.edit)) return null;
  const s = data.story;
  const act = async (fn: () => Promise<unknown>, text: string) => {
    setMessage(null);
    if (await run(fn)) {
      setMessage(text);
      setForm(null);
      void reload();
    }
  };
  return (
    <section className="card" aria-labelledby="h-story">
      <h2 id="h-story">{t('elaboration.story.title')}</h2>
      <ErrorBox error={error} />
      {message && <p className="alert success" role="status">{message}</p>}
      {s && <p className="small"><span className="badge">{STORY_STATUS[s.status]}</span></p>}
      {s && !form && (
        <>
          <h3>{s.title}</h3>
          <p className="pre">{s.body}</p>
        </>
      )}
      {!s && !form && <p className="muted">{t('elaboration.story.none')}</p>}
      {form && (
        <form onSubmit={(e) => { e.preventDefault(); void act(() => api.put(`/api/ideas/${ideaId}/success-story`, form), t('elaboration.story.saved')); }}>
          <SuccessStoryDraft ideaId={ideaId} onDraft={setForm} />
          <Field id="story-title" label={t('elaboration.story.heading')}>
            <input id="story-title" type="text" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} required />
          </Field>
          <Field id="story-body" label={t('elaboration.story.text')} hint={t('elaboration.story.textHint')}>
            <textarea id="story-body" rows={8} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} required />
          </Field>
          <div className="row">
            <button type="button" onClick={() => setForm(null)}>{t('elaboration.cancel')}</button>
            <button className="primary" disabled={busy}>{t('elaboration.story.save')}</button>
          </div>
        </form>
      )}
      <div className="row" style={{ marginTop: 8 }}>
        {data.can.edit && !form && <button type="button" onClick={() => setForm({ title: s?.title ?? '', body: s?.body ?? '' })}>{s ? t('elaboration.story.edit') : t('elaboration.story.write')}</button>}
        {data.can.send && !form && (
          <button type="button" className="primary" disabled={busy} onClick={() => act(() => api.post(`/api/ideas/${ideaId}/success-story/send`), t('elaboration.story.sentMessage'))}>
            {t('elaboration.story.send')}
          </button>
        )}
      </div>
      {data.can.approve && (
        <div className="alert info" style={{ marginTop: 10 }}>
          <p style={{ marginTop: 0 }}>{t('elaboration.story.reviewHint')}</p>
          <label className="check">
            <input type="checkbox" checked={nameAuthors} onChange={(e) => setNameAuthors(e.target.checked)} /> {t('elaboration.story.nameAuthors')}
          </label>
          <div className="row">
            <button type="button" disabled={busy} onClick={() => act(() => api.post(`/api/ideas/${ideaId}/success-story/decline`), t('elaboration.story.declined'))}>{t('elaboration.story.decline')}</button>
            <button type="button" className="primary" disabled={busy} onClick={() => act(() => api.post(`/api/ideas/${ideaId}/success-story/approve`, { nameAuthors }), t('elaboration.story.approved'))}>
              {t('elaboration.story.approve')}
            </button>
          </div>
        </div>
      )}
      {s?.status === 'published' && <p className="small"><Link to="/erfolge">{t('elaboration.story.toSuccess')}</Link> · <Link to={`/erfolge/${s.id}/urkunde`}>{t('elaboration.story.certificate')}</Link></p>}
    </section>
  );
}
