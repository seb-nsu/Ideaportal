import { useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation, useParams } from 'react-router-dom';
import { ApiError, api, type Deadline, type IdeaListItem, type UserRef } from '../api';
import { DeadlineLight, ErrorBox, Field, Loading, StatusBadge, UserPicker, readBase64, useAction, useLoad } from '../components';
import { BENEFIT, CHANNELS, LANES, NEXT_STEP, STATUS, STEPS } from '../labels';
import { formatDate, formatDateTime, formatNumber, labelMap, t } from '../i18n';
import { hasRole, isStaff, useSession } from '../session';
import { InventionPanel } from './idea/Invention';
import { ChallengeValues, DecisionForm, MentorField, defaultTimebox } from './idea/Elaboration';
import { Handover } from './idea/Handover';
import { SteckbriefSummary, WITH_STECKBRIEF, steckbriefPath, tabForAnchor } from './idea/Steckbrief';
import { AiPanel, DiscussionSummary, ReplyDraftButton } from '../ai/AiPanel';
import { ProblemSolutions, ProblemToChallenge } from './idea/Problem';
import { ReportButton } from './Moderation';
import { TranslateComment, TranslateIdea } from '../ai/Translate';

interface Detail {
  id: string;
  number: number;
  title: string;
  problem: string;
  solution: string;
  benefit: string;
  topic: string | null;
  ideaType: 'internal' | 'product';
  ideaKind?: 'idea' | 'problem';
  confidential: boolean;
  anonymous: boolean;
  status: string;
  forwardedTo: string | null;
  resubmitOn: string | null;
  submittedAt: string | null;
  challenge: { id: string; title: string } | null;
  author: { id: string; name: string; orgUnit: string | null } | null;
  submittedBy: { name: string | null } | null;
  authorConfirmed: boolean;
  deadline: Deadline | null;
  events: { id: number; kind: string; toStatus: string | null; message: string | null; createdAt: string; actorName: string | null }[];
  comments: { id: string; parentId: string | null; body: string; createdAt: string; authorName: string; kind?: 'comment' | 'solution' }[];
  supporters: number;
  supportedByMe: boolean;
  questions: { round: number; question: string; answer: string | null; askedOn: string }[];
  decisions: { gate: number; outcome: string; reason: string | null; ownerName: string | null; decidedAt: string; resubmitOn: string | null }[];
  implementation: {
    ownerId: string;
    ownerName: string;
    channel: string;
    orgUnit: string | null;
    externalRef: string | null;
    targetDate: string;
    progress: number;
    status: 'proposed' | 'active' | 'done';
    benefitKind: string | null;
    benefitValue: number | null;
    benefitEvidence: string | null;
  } | null;
  feedbackPending: string | null;
  coauthors: { id: string; name: string }[];
  attachments: { id: string; filename: string; mime: string; size: number; scanStatus: 'clean' | 'type_checked'; createdAt: string }[];
  mergedInto: { id: string; number: number; title: string } | null;
  mentor: { id: string; name: string } | null;
  timeboxUntil: string | null;
  teamName: string | null;
  originalText: string | null;
  challengeValues: { id: string; label: string; value: string | number }[];
  can: Record<
    | 'edit' | 'submit' | 'confirmAuthorship' | 'answer' | 'ask' | 'triage' | 'decide' | 'decideDelegated' | 'acceptImplementation' | 'manageImplementation'
    | 'closeImplementation' | 'comment' | 'support' | 'merge' | 'manageCoauthors' | 'attach' | 'deleteAttachments',
    boolean
  > & { report?: boolean };
  // External participation and moderation (R3-19, R3-21).
  origin?: 'internal' | 'external';
  moderation?: 'pending' | 'approved' | 'hidden' | null;
}

const EVENT_LABEL = labelMap('ideaDetail.event', [
  'created', 'submitted', 'question', 'answer', 'gate1', 'gate2', 'implementation_accepted', 'implementation_progress',
  'completed', 'closed', 'escalation', 'resubmission', 'authorship_confirmed', 'merged', 'merged_in', 'coauthor_added',
  'imported', 'mentor_assigned', 'timebox_exceeded', 'meeting_scheduled', 'experiment_started', 'experiment_result',
  'impact_review', 'success_story', 'benefit_confirmed', 'handover', 'external_status', 'implementation_package',
] as const);

export function IdeaDetail() {
  const { id } = useParams();
  const location = useLocation();
  const { data, error, loading, reload } = useLoad<Detail>(`/api/ideas/${id}`);
  const { me } = useSession();
  if (loading && !data) return <Loading />;
  if (error || !data) return <ErrorBox error={error ?? t('ideaDetail.notFound')} />;
  const d = data;
  const justSubmitted = (location.state as { submitted?: boolean } | null)?.submitted && d.status === 'submitted';
  const hasSteckbrief = WITH_STECKBRIEF.includes(d.status);
  const invention = hasRole(me, 'triage', 'admin') && d.status !== 'draft';
  // Old anchors (#h-dossier, #h-score, #ai-…) now live on a tab of the Steckbrief page (R2-47).
  const movedTo = hasSteckbrief ? tabForAnchor(location.hash) : null;
  if (movedTo) return <Navigate to={steckbriefPath(d.id, movedTo, location.hash)} replace />;

  return (
    <div className="stack">
      {justSubmitted && (
        <div className="alert success" role="status">
          {t('ideaDetail.thanks', { date: formatDate(d.deadline?.dueOn) })}
        </div>
      )}
      <div className="row spread">
        <div>
          <p className="muted small" style={{ margin: 0 }}>
            #{d.number} · {d.topic ?? t('ideaDetail.noTopic')} · {d.ideaType === 'product' ? t('ideaDetail.typeProduct') : t('ideaDetail.typeInternal')}
            {d.challenge && <> · {t('ideaDetail.challenge')} <Link to={`/challenges/${d.challenge.id}`}>{d.challenge.title}</Link></>}
          </p>
          <h1>{d.title}</h1>
          <div className="row small">
            <StatusBadge status={d.status} />
            <span>
              {d.author ? `${t('ideaDetail.by', { name: d.author.name })}${d.author.orgUnit ? ` (${d.author.orgUnit})` : ''}` : t('ideaDetail.anonymousSubmitted')}
              {d.coauthors.length > 0 && t('ideaDetail.with', { names: d.coauthors.map((c) => c.name).join(', ') })}
            </span>
            {d.submittedBy?.name && <span className="muted">{t('ideaDetail.capturedBy', { name: d.submittedBy.name })}</span>}
            {d.ideaKind === 'problem' && <span className="badge accent">{t('usecases.problem.badge')}</span>}
            {d.confidential && <span className="badge">{t('ideaDetail.badgeConfidential')}</span>}
            {d.anonymous && <span className="badge">{t('ideaDetail.badgeAnonymous')}</span>}
            {d.origin === 'external' && <span className="badge accent">{t('external.badge')}</span>}
            {d.moderation === 'pending' && <span className="badge yellow">{t('external.moderation.waiting')}</span>}
            {d.moderation === 'hidden' && <span className="badge red">{t('external.moderation.notPublished')}</span>}
          </div>
        </div>
        {d.can.edit && <Link className="button primary" to={`/einreichen/${d.id}`}>{t('ideaDetail.editDraft')}</Link>}
      </div>

      {d.mergedInto && (
        <div className="alert info" role="status">
          {t('ideaDetail.mergedBefore')} <Link to={`/ideen/${d.mergedInto.id}`}>#{d.mergedInto.number} {d.mergedInto.title}</Link>{t('ideaDetail.mergedAfter')}
        </div>
      )}
      <StatusBar detail={d} />

      <div className="layout-detail">
        <div className="stack">
          <section className="card">
            <h2>{t('ideaDetail.problem')}</h2>
            <p className="pre">{d.problem || '–'}</p>
            <h2>{d.ideaKind === 'problem' ? t('usecases.problem.ownSolution') : t('ideaDetail.idea')}</h2>
            <p className="pre">{d.solution || '–'}</p>
            <h2>{t('ideaDetail.benefit')}</h2>
            <p className="pre">{d.benefit || '–'}</p>
            <ChallengeValues values={d.challengeValues ?? []} teamName={d.teamName ?? null} />
            {d.status !== 'draft' && <TranslateIdea ideaId={d.id} />}
            {d.originalText && (
              <details>
                <summary className="small">{t('ideaDetail.originalText')}</summary>
                <p className="pre small">{d.originalText}</p>
              </details>
            )}
            {d.can.support && <SupportButton detail={d} onDone={reload} />}
            {!d.can.support && d.status !== 'draft' && <p className="muted small">{t('ideaDetail.supporters', { n: d.supporters })}</p>}
            {d.can.report && <ReportButton ideaId={d.id} />}
          </section>
          {hasSteckbrief && <SteckbriefSummary ideaId={d.id} onChanged={reload} />}
          {d.status !== 'draft' && !hasSteckbrief && <AiPanel ideaId={d.id} />}
          {(d.attachments.length > 0 || d.can.attach) && <Attachments detail={d} onDone={reload} />}
          {d.implementation && <ImplementationCard detail={d} onDone={reload} />}
          {d.implementation && <Handover ideaId={d.id} onChanged={reload} />}
          <History detail={d} />
          {d.ideaKind === 'problem' && d.status !== 'draft' && <ProblemSolutions ideaId={d.id} solutions={d.comments.filter((c) => c.kind === 'solution')} canPropose={d.can.comment} onDone={reload} />}
          {d.can.comment && <Comments detail={d} onDone={reload} />}
        </div>
        <div className="stack">
          {d.can.confirmAuthorship && <ConfirmAuthorship id={d.id} onDone={reload} />}
          {d.can.answer && <AnswerPanel detail={d} onDone={reload} />}
          {d.feedbackPending && <FeedbackPanel id={d.id} onDone={reload} />}
          {d.ideaKind === 'problem' && d.can.triage && <ProblemToChallenge idea={d} />}
          {(d.can.triage || d.can.ask) && <TriagePanel detail={d} onDone={reload} />}
          {d.can.decide && <DecisionPanel detail={d} onDone={reload} />}
          {/* Rarely needed actions stay folded so the pending task stands out (usability review 10/2026). */}
          {(invention || d.can.merge || d.can.manageCoauthors) && (
            <details className="more-actions">
              <summary>{t('ideaDetail.moreActions', { list: [invention && t('ideaDetail.moreActions.invention'), d.can.merge && t('ideaDetail.moreActions.merge'), d.can.manageCoauthors && t('ideaDetail.moreActions.coauthors')].filter(Boolean).join(', ') })}</summary>
              <div className="stack">
                {invention && <InventionPanel key={`${d.id}-${d.status}`} ideaId={d.id} onDone={reload} />}
                {d.can.merge && <MergePanel detail={d} onDone={reload} />}
                {d.can.manageCoauthors && <CoauthorsPanel detail={d} onDone={reload} />}
              </div>
            </details>
          )}
        </div>
      </div>
    </div>
  );
}

function StatusBar({ detail: d }: { detail: Detail }) {
  const { me } = useSession();
  const staff = isStaff(me);
  const current = STEPS.findIndex((s) => s.statuses.includes(d.status));
  return (
    <section className="card" aria-labelledby="h-status">
      <h2 id="h-status" className="sr-only">{t('ideaDetail.status')}</h2>
      <ol className="steps">
        {STEPS.map((s, i) => (
          <li key={s.key} className={i < current ? 'done' : i === current ? 'current' : ''} aria-current={i === current ? 'step' : undefined}>
            {staff ? s.label : s.plain}
          </li>
        ))}
      </ol>
      <p style={{ margin: 0 }}>
        <strong>{STATUS[d.status]}</strong>
        {d.forwardedTo && t('ideaDetail.forwardedTo', { to: d.forwardedTo })}
        {d.resubmitOn && t('ideaDetail.resubmitOn', { date: formatDate(d.resubmitOn) })}. {NEXT_STEP[d.status]}
      </p>
      {d.deadline && (
        <p style={{ margin: '6px 0 0' }}>
          {d.deadline.phase === 'gate1' ? t('ideaDetail.deadlineGate1') : t('ideaDetail.deadlineElaboration')}: <DeadlineLight deadline={d.deadline} />
        </p>
      )}
    </section>
  );
}

function SupportButton({ detail: d, onDone }: { detail: Detail; onDone: () => void }) {
  const { busy, error, run } = useAction();
  const toggle = async () => {
    if (await run(() => (d.supportedByMe ? api.del(`/api/ideas/${d.id}/support`) : api.post(`/api/ideas/${d.id}/support`)))) onDone();
  };
  return (
    <div>
      <ErrorBox error={error} />
      <button type="button" onClick={toggle} disabled={busy} aria-pressed={d.supportedByMe}>
        👍 {d.supportedByMe ? t('ideaDetail.supporting') : t('ideaDetail.support')} ({d.supporters})
      </button>
    </div>
  );
}

function History({ detail: d }: { detail: Detail }) {
  return (
    <section className="card" aria-labelledby="h-history">
      <h2 id="h-history">{t('ideaDetail.history')}</h2>
      <ol className="timeline">
        {d.events.map((e) => (
          <li key={e.id}>
            <div className="small muted">
              {formatDateTime(e.createdAt)}
              {e.actorName && ` · ${e.actorName}`}
            </div>
            <strong>{EVENT_LABEL[e.kind] ?? e.kind}</strong>
            {e.toStatus && e.kind.startsWith('gate') && ` → ${STATUS[e.toStatus]}`}
            {e.message && <p className="pre small" style={{ marginTop: 4 }}>{e.message}</p>}
          </li>
        ))}
      </ol>
    </section>
  );
}

function Comments({ detail: d, onDone }: { detail: Detail; onDone: () => void }) {
  const [body, setBody] = useState('');
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const { busy, error, run } = useAction();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (await run(() => api.post(`/api/ideas/${d.id}/comments`, { body, parentId: replyTo ?? undefined }))) {
      setBody('');
      setReplyTo(null);
      onDone();
    }
  };
  // Solution proposals for a problem (R3-31) have their own section.
  const roots = d.comments.filter((c) => !c.parentId && c.kind !== 'solution');
  const replies = (id: string) => d.comments.filter((c) => c.parentId === id);
  return (
    <section className="card" aria-labelledby="h-comments">
      <h2 id="h-comments">{t('ideaDetail.discussion', { n: d.comments.length })}</h2>
      {roots.length === 0 && <p className="muted">{t('ideaDetail.noComments')}</p>}
      <DiscussionSummary ideaId={d.id} comments={d.comments.length} />
      <ul className="idea-list">
        {roots.map((c) => (
          <li key={c.id} id={`comment-${c.id}`}>
            <div className="small muted">{c.authorName} · {formatDateTime(c.createdAt)}</div>
            <p className="pre">{c.body}</p>
            <TranslateComment ideaId={d.id} commentId={c.id} />
            {replies(c.id).map((r) => (
              <div key={r.id} id={`comment-${r.id}`} style={{ marginLeft: 20, borderLeft: '2px solid var(--border)', paddingLeft: 10 }}>
                <div className="small muted">{r.authorName} · {formatDateTime(r.createdAt)}</div>
                <p className="pre">{r.body}</p>
                <TranslateComment ideaId={d.id} commentId={r.id} />
              </div>
            ))}
            <div className="row">
              <button type="button" className="link small" onClick={() => setReplyTo(c.id)}>{t('ideaDetail.reply')}</button>
              <ReportButton ideaId={d.id} commentId={c.id} compact />
            </div>
          </li>
        ))}
      </ul>
      <form onSubmit={submit}>
        <ErrorBox error={error} />
        <Field id="comment" label={replyTo ? t('ideaDetail.yourAnswer') : t('ideaDetail.yourComment')}>
          <textarea id="comment" value={body} onChange={(e) => setBody(e.target.value)} required />
        </Field>
        <div className="row">
          <button className="primary" disabled={busy || !body.trim()}>{t('ideaDetail.send')}</button>
          {replyTo && <button type="button" onClick={() => setReplyTo(null)}>{t('ideaDetail.cancelReply')}</button>}
        </div>
      </form>
    </section>
  );
}

function ConfirmAuthorship({ id, onDone }: { id: string; onDone: () => void }) {
  const { busy, error, run } = useAction();
  return (
    <section className="card">
      <h2>{t('ideaDetail.authorship.heading')}</h2>
      <p>{t('ideaDetail.authorship.text')}</p>
      <ErrorBox error={error} />
      <button className="primary" disabled={busy} onClick={async () => (await run(() => api.post(`/api/ideas/${id}/confirm-authorship`))) && onDone()}>
        {t('ideaDetail.authorship.confirm')}
      </button>
    </section>
  );
}

function AnswerPanel({ detail: d, onDone }: { detail: Detail; onDone: () => void }) {
  const open = d.questions.find((q) => !q.answer);
  const [answer, setAnswer] = useState('');
  const { busy, error, run } = useAction();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (await run(() => api.post(`/api/ideas/${d.id}/answer`, { answer }))) onDone();
  };
  return (
    <section className="card alert warn">
      <h2>{t('ideaDetail.answer.heading')}</h2>
      <p className="pre">{open?.question}</p>
      <form onSubmit={submit}>
        <ErrorBox error={error} />
        <Field id="answer" label={t('ideaDetail.yourAnswer')}>
          <textarea id="answer" value={answer} onChange={(e) => setAnswer(e.target.value)} required />
        </Field>
        <button className="primary" disabled={busy || answer.trim().length < 2}>{t('ideaDetail.answer.send')}</button>
      </form>
    </section>
  );
}

function FeedbackPanel({ id, onDone }: { id: string; onDone: () => void }) {
  const [score, setScore] = useState<number | null>(null);
  const [comment, setComment] = useState('');
  const { busy, error, run } = useAction();
  const submit = async () => {
    if (score && (await run(() => api.post(`/api/ideas/${id}/feedback`, { score, comment: comment || null })))) onDone();
  };
  return (
    <section className="card" aria-labelledby="h-feedback">
      <h2 id="h-feedback">{t('ideaDetail.feedback.heading')}</h2>
      <ErrorBox error={error} />
      <div className="stars" role="radiogroup" aria-label={t('ideaDetail.feedback.scale')}>
        {[1, 2, 3, 4, 5].map((n) => (
          <button key={n} type="button" role="radio" aria-checked={score === n} className={score === n ? 'primary' : ''} onClick={() => setScore(n)}>
            {n}
          </button>
        ))}
      </div>
      <p className="small muted">{t('ideaDetail.feedback.hint')}</p>
      <Field id="fb-comment" label={t('ideaDetail.feedback.comment')}>
        <input id="fb-comment" type="text" value={comment} onChange={(e) => setComment(e.target.value)} />
      </Field>
      <button className="primary" disabled={!score || busy} onClick={submit}>{t('ideaDetail.feedback.send')}</button>
    </section>
  );
}

function TriagePanel({ detail: d, onDone }: { detail: Detail; onDone: () => void }) {
  const { settings } = useSession();
  const [lane, setLane] = useState<'fast_lane' | 'elaborate' | 'forward' | 'reject'>('elaborate');
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [owner, setOwner] = useState<UserRef | null>(null);
  const [orgUnit, setOrgUnit] = useState('');
  const [targetDate, setTargetDate] = useState('');
  const [channelId, setChannelId] = useState('');
  const [deleteContent, setDeleteContent] = useState(false);
  const [question, setQuestion] = useState('');
  const [mentor, setMentor] = useState<UserRef | null>(null);
  const [timeboxUntil, setTimeboxUntil] = useState(defaultTimebox(settings.today, settings.elaboration.timeboxWeeks));
  const { busy, error, run } = useAction();
  const text = message ?? settings.lanes[lane];

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const body: Record<string, unknown> = { lane, reason: reason || undefined, message: text };
    if (lane === 'fast_lane') Object.assign(body, { ownerId: owner?.id, orgUnit, targetDate });
    if (lane === 'forward') Object.assign(body, { channelId, deleteContent });
    if (lane === 'elaborate') Object.assign(body, { mentorId: mentor?.id, timeboxUntil });
    if (await run(() => api.post(`/api/ideas/${d.id}/triage`, body))) onDone();
  };
  const ask = async (e: FormEvent) => {
    e.preventDefault();
    if (await run(() => api.post(`/api/ideas/${d.id}/question`, { question }))) onDone();
  };
  const reasonRequired = lane === 'forward' || lane === 'reject';

  return (
    <section className="card" aria-labelledby="h-triage">
      <h2 id="h-triage">{t('ideaDetail.triage.heading')}</h2>
      <ErrorBox error={error} />
      {d.can.triage && (
        <form onSubmit={submit}>
          <fieldset>
            <legend>{t('ideaDetail.triage.lane')}</legend>
            {(Object.keys(LANES) as (keyof typeof LANES)[]).map((l) => (
              <label key={l} className="check">
                <input type="radio" name="lane" checked={lane === l} onChange={() => { setLane(l as typeof lane); setMessage(null); }} /> {LANES[l]}
              </label>
            ))}
            <p className="hint">
              {t('ideaDetail.triage.fastLaneHint', { days: settings.thresholds.fastLaneMaxPersonDays, euro: formatNumber(settings.thresholds.fastLaneMaxEuro) })}
            </p>
          </fieldset>
          {lane === 'fast_lane' && (
            <>
              <Field id="owner" label={t('ideaDetail.triage.owner')}>
                <UserPicker id="owner" value={owner} onChange={setOwner} />
              </Field>
              <Field id="orgUnit" label={t('ideaDetail.triage.orgUnit')}>
                <input id="orgUnit" type="text" value={orgUnit} onChange={(e) => setOrgUnit(e.target.value)} required />
              </Field>
              <Field id="target" label={t('ideaDetail.targetDate')}>
                <input id="target" type="date" value={targetDate} min={settings.today} onChange={(e) => setTargetDate(e.target.value)} required />
              </Field>
            </>
          )}
          {lane === 'elaborate' && <MentorField mentor={mentor} onMentor={setMentor} timeboxUntil={timeboxUntil} onTimebox={setTimeboxUntil} />}
          {lane === 'forward' && (
            <>
              <Field id="channel" label={t('ideaDetail.triage.channel')} hint={settings.targetChannels.length ? undefined : t('ideaDetail.triage.noChannels')}>
                <select id="channel" value={channelId} onChange={(e) => setChannelId(e.target.value)} required>
                  <option value="">{t('ideaDetail.triage.choose')}</option>
                  {settings.targetChannels.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </Field>
              <label className="check">
                <input type="checkbox" checked={deleteContent} onChange={(e) => setDeleteContent(e.target.checked)} /> {t('ideaDetail.triage.deleteContent')}
              </label>
              {settings.targetChannels.find((c) => c.id === channelId)?.kind === 'patent' && <p className="hint">{t('compliance.invention.forwardHint')}</p>}
            </>
          )}
          <Field id="reason" label={reasonRequired ? t('ideaDetail.triage.reasonRequired') : t('ideaDetail.triage.reasonOptional')} hint={reasonRequired ? t('ideaDetail.triage.reasonHint') : undefined}>
            <textarea id="reason" value={reason} onChange={(e) => setReason(e.target.value)} required={reasonRequired} />
          </Field>
          <Field id="message" label={t('ideaDetail.triage.message')} hint={t('ideaDetail.triage.messageHint')}>
            <textarea id="message" value={text} onChange={(e) => setMessage(e.target.value)} />
          </Field>
          <ReplyDraftButton ideaId={d.id} lane={lane} reason={reason} onDraft={setMessage} />
          <button className="primary" disabled={busy}>{t('ideaDetail.triage.save')}</button>
        </form>
      )}
      {d.can.ask && (
        <form onSubmit={ask} style={{ marginTop: 20 }}>
          <h3>{t('ideaDetail.ask.heading')}</h3>
          <p className="hint">{t('ideaDetail.ask.hint', { max: settings.deadlines.maxQuestionRounds, n: d.questions.length })}</p>
          <Field id="question" label={t('ideaDetail.ask.question')}>
            <textarea id="question" value={question} onChange={(e) => setQuestion(e.target.value)} required />
          </Field>
          <button disabled={busy || question.trim().length < 5}>{t('ideaDetail.ask.send')}</button>
        </form>
      )}
    </section>
  );
}

function DecisionPanel({ detail: d, onDone }: { detail: Detail; onDone: () => void }) {
  return (
    <section className="card" aria-labelledby="h-decision">
      <h2 id="h-decision">{t('ideaDetail.decision.heading')}</h2>
      <DecisionForm ideaId={d.id} delegated={d.can.decideDelegated} onDone={onDone} />
    </section>
  );
}

function ImplementationCard({ detail: d, onDone }: { detail: Detail; onDone: () => void }) {
  const im = d.implementation!;
  const [progress, setProgress] = useState(im.progress);
  const [externalRef, setExternalRef] = useState(im.externalRef ?? '');
  const [targetDate, setTargetDate] = useState(im.targetDate);
  const [closing, setClosing] = useState(false);
  const [kind, setKind] = useState('euro');
  const [value, setValue] = useState('');
  const [evidence, setEvidence] = useState('');
  const [effort, setEffort] = useState({ days: '', euro: '' });
  const { busy, error, run } = useAction();

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (await run(() => api.patch(`/api/ideas/${d.id}/implementation`, { progress, externalRef: externalRef || null, targetDate }))) onDone();
  };
  const close = async (e: FormEvent) => {
    e.preventDefault();
    const num = (v: string) => (v.trim() === '' ? null : Number(v.replace(',', '.')));
    const body = { benefitKind: kind, benefitValue: num(value), benefitEvidence: evidence, actualEffortPersonDays: num(effort.days), actualEffortEuro: num(effort.euro) };
    if (await run(() => api.post(`/api/ideas/${d.id}/implementation/close`, body))) onDone();
  };

  return (
    <section className="card" aria-labelledby="h-impl">
      <h2 id="h-impl">{t('ideaDetail.impl.heading')}</h2>
      <ErrorBox error={error} />
      <p>
        {t('ideaDetail.impl.owner')} <strong>{im.ownerName}</strong>
        {im.orgUnit && ` · ${im.orgUnit}`} · {t('ideaDetail.impl.channel', { channel: CHANNELS[im.channel] })} · {t('ideaDetail.impl.target', { date: formatDate(im.targetDate) })}
        {im.externalRef && ` · ${t('ideaDetail.impl.ref', { ref: im.externalRef })}`}
      </p>
      <div className="progress" role="progressbar" aria-valuenow={im.progress} aria-valuemin={0} aria-valuemax={100} aria-label={t('ideaDetail.impl.progressLabel')}>
        <span style={{ width: `${im.progress}%` }} />
      </div>
      <p className="small muted">{im.progress} % · {im.status === 'proposed' ? t('ideaDetail.impl.statusProposed') : im.status === 'active' ? t('ideaDetail.impl.statusActive') : t('ideaDetail.impl.statusDone')}</p>
      {im.status === 'done' && (
        <div className="alert success">
          <strong>{t('ideaDetail.impl.actualBenefit')}</strong> {im.benefitValue != null ? `${formatNumber(im.benefitValue)} ` : ''}{BENEFIT[im.benefitKind ?? '']}
          <p className="pre small" style={{ margin: 0 }}>{im.benefitEvidence}</p>
        </div>
      )}
      {d.can.acceptImplementation && (
        <button className="primary" disabled={busy} onClick={async () => (await run(() => api.post(`/api/ideas/${d.id}/implementation/accept`))) && onDone()}>
          {t('ideaDetail.impl.accept')}
        </button>
      )}
      {d.can.manageImplementation && im.status === 'active' && !closing && (
        <form onSubmit={save}>
          <div className="grid grid-3">
            <Field id="progress" label={t('ideaDetail.impl.progress', { n: progress })}>
              <input id="progress" type="range" min={0} max={100} step={5} value={progress} onChange={(e) => setProgress(Number(e.target.value))} style={{ width: '100%' }} />
            </Field>
            <Field id="ref" label={t('ideaDetail.impl.externalRef')} hint={t('ideaDetail.impl.externalRefHint')}>
              <input id="ref" type="text" value={externalRef} onChange={(e) => setExternalRef(e.target.value)} />
            </Field>
            <Field id="impl-target" label={t('ideaDetail.targetDate')}>
              <input id="impl-target" type="date" value={targetDate} onChange={(e) => setTargetDate(e.target.value)} />
            </Field>
          </div>
          <div className="row">
            <button disabled={busy}>{t('ideaDetail.save')}</button>
            {d.can.closeImplementation && <button type="button" className="primary" onClick={() => setClosing(true)}>{t('ideaDetail.impl.closeWithBenefit')}</button>}
          </div>
        </form>
      )}
      {closing && (
        <form onSubmit={close}>
          <h3>{t('ideaDetail.impl.closeHeading')}</h3>
          <Field id="kind" label={t('ideaDetail.impl.benefitKind')}>
            <select id="kind" value={kind} onChange={(e) => setKind(e.target.value)}>
              {Object.entries(BENEFIT).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </Field>
          <Field id="value" label={t('ideaDetail.impl.value')} hint={t('ideaDetail.impl.valueHint')}>
            <input id="value" type="text" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} />
          </Field>
          <Field id="evidence" label={t('ideaDetail.impl.evidence')} hint={t('ideaDetail.impl.evidenceHint')}>
            <textarea id="evidence" value={evidence} onChange={(e) => setEvidence(e.target.value)} required />
          </Field>
          <div className="grid grid-2">
            <Field id="actual-days" label={t('learning.close.actualDays')} hint={t('learning.close.hint')}>
              <input id="actual-days" type="text" inputMode="decimal" value={effort.days} onChange={(e) => setEffort({ ...effort, days: e.target.value })} />
            </Field>
            <Field id="actual-euro" label={t('learning.close.actualEuro')}>
              <input id="actual-euro" type="text" inputMode="decimal" value={effort.euro} onChange={(e) => setEffort({ ...effort, euro: e.target.value })} />
            </Field>
          </div>
          <div className="row">
            <button type="button" onClick={() => setClosing(false)}>{t('ideaDetail.cancel')}</button>
            <button className="primary" disabled={busy}>{t('ideaDetail.impl.close')}</button>
          </div>
        </form>
      )}
    </section>
  );
}

function formatSize(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${formatNumber(bytes / 1024 / 1024, 1)} MB`;
}

function Attachments({ detail: d, onDone }: { detail: Detail; onDone: () => void }) {
  const { busy, error, run, setError } = useAction();
  const [inputKey, setInputKey] = useState(0);
  const upload = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) return setError(new ApiError(400, t('ideaDetail.files.tooLarge')));
    const data = await readBase64(file);
    if (await run(() => api.post(`/api/ideas/${d.id}/attachments`, { filename: file.name, data }))) onDone();
    setInputKey((k) => k + 1);
  };
  const remove = async (id: string) => {
    if (await run(() => api.del(`/api/ideas/${d.id}/attachments/${id}`))) onDone();
  };
  return (
    <section className="card" aria-labelledby="h-files">
      <h2 id="h-files">{t('ideaDetail.files.heading')}</h2>
      <ErrorBox error={error} />
      {d.attachments.length === 0 && <p className="muted">{t('ideaDetail.files.empty')}</p>}
      <ul className="idea-list">
        {d.attachments.map((a) => (
          <li key={a.id} className="row spread">
            <span>
              <a href={`/api/ideas/${d.id}/attachments/${a.id}`} download={a.filename}>{a.filename}</a>{' '}
              <span className="small muted">{formatSize(a.size)}{a.scanStatus === 'clean' ? t('ideaDetail.files.scanned') : ''}</span>
            </span>
            {d.can.deleteAttachments && (
              <button type="button" className="link" onClick={() => remove(a.id)} disabled={busy} aria-label={t('ideaDetail.files.deleteLabel', { name: a.filename })}>{t('ideaDetail.files.delete')}</button>
            )}
          </li>
        ))}
      </ul>
      {d.can.attach && (
        <Field id="file" label={t('ideaDetail.files.attach')} hint={t('ideaDetail.files.attachHint')}>
          <input key={inputKey} id="file" type="file" disabled={busy}
            accept=".png,.jpg,.jpeg,.gif,.webp,.pdf,.docx,.xlsx,.pptx,.txt,.csv" onChange={(e) => upload(e.target.files?.[0])} />
        </Field>
      )}
    </section>
  );
}

function CoauthorsPanel({ detail: d, onDone }: { detail: Detail; onDone: () => void }) {
  const [person, setPerson] = useState<UserRef | null>(null);
  const { busy, error, run } = useAction();
  const add = async () => {
    if (person && (await run(() => api.post(`/api/ideas/${d.id}/coauthors`, { userId: person.id })))) {
      setPerson(null);
      onDone();
    }
  };
  return (
    <section className="card" aria-labelledby="h-coauthors">
      <h2 id="h-coauthors">{t('ideaDetail.coauthors.heading')}</h2>
      <p className="small muted">{t('ideaDetail.coauthors.text')}</p>
      <ErrorBox error={error} />
      {d.coauthors.length > 0 && (
        <ul className="idea-list">
          {d.coauthors.map((c) => (
            <li key={c.id} className="row spread">
              {c.name}
              <button type="button" className="link" disabled={busy} aria-label={t('ideaDetail.coauthors.removeLabel', { name: c.name })}
                onClick={async () => (await run(() => api.del(`/api/ideas/${d.id}/coauthors/${c.id}`))) && onDone()}>
                {t('ideaDetail.coauthors.remove')}
              </button>
            </li>
          ))}
        </ul>
      )}
      <Field id="coauthor" label={t('ideaDetail.coauthors.add')}>
        <UserPicker id="coauthor" value={person} onChange={setPerson} />
      </Field>
      <button type="button" disabled={!person || busy} onClick={add}>{t('ideaDetail.coauthors.addButton')}</button>
    </section>
  );
}

function MergePanel({ detail: d, onDone }: { detail: Detail; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [target, setTarget] = useState<IdeaListItem | null>(null);
  const [reason, setReason] = useState('');
  const { data } = useLoad<IdeaListItem[]>(open ? `/api/ideas?scope=all&q=${encodeURIComponent(q || d.title.split(' ').slice(0, 2).join(' '))}` : null);
  const { busy, error, run } = useAction();
  const candidates = (data ?? []).filter((i) => i.id !== d.id && !['draft', 'merged', 'rejected', 'forwarded', 'closed_no_answer'].includes(i.status));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (target && (await run(() => api.post(`/api/ideas/${d.id}/merge`, { targetId: target.id, reason })))) {
      setOpen(false);
      onDone();
    }
  };
  if (!open) {
    return (
      <section className="card">
        <h2>{t('ideaDetail.merge.duplicate')}</h2>
        <p className="small muted">{t('ideaDetail.merge.text')}</p>
        <button type="button" onClick={() => setOpen(true)}>{t('ideaDetail.merge.open')}</button>
      </section>
    );
  }
  return (
    <section className="card" aria-labelledby="h-merge">
      <h2 id="h-merge">{t('ideaDetail.merge.heading')}</h2>
      <form onSubmit={submit}>
        <ErrorBox error={error} />
        <Field id="merge-q" label={t('ideaDetail.merge.search')}>
          <input id="merge-q" type="search" value={q} onChange={(e) => { setQ(e.target.value); setTarget(null); }} placeholder={t('ideaDetail.merge.searchPlaceholder')} />
        </Field>
        <fieldset>
          <legend>{t('ideaDetail.merge.target')}</legend>
          {candidates.length === 0 && <p className="small muted">{t('ideaDetail.merge.none')}</p>}
          {candidates.slice(0, 8).map((i) => (
            <label key={i.id} className="check">
              <input type="radio" name="merge-target" checked={target?.id === i.id} onChange={() => setTarget(i)} /> #{i.number} {i.title}
            </label>
          ))}
        </fieldset>
        <Field id="merge-reason" label={t('ideaDetail.merge.reason')} hint={t('ideaDetail.merge.reasonHint')}>
          <textarea id="merge-reason" value={reason} onChange={(e) => setReason(e.target.value)} required />
        </Field>
        <div className="row">
          <button type="button" onClick={() => setOpen(false)}>{t('ideaDetail.cancel')}</button>
          <button className="primary" disabled={busy || !target || reason.trim().length < 10}>{t('ideaDetail.merge.submit')}</button>
        </div>
      </form>
    </section>
  );
}
