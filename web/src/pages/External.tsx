import { useState, type FormEvent } from 'react';
import { Link, NavLink, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import { ApiError, api } from '../api';
import { ErrorBox, Field, Loading, StatusBadge, useAction, useLoad } from '../components';
import { formatDate, formatDateTime, t } from '../i18n';
import { LANES, OUTCOMES } from '../labels';
import { LanguageSwitch } from '../LanguageSwitch';
import { useSession } from '../session';
import { FeatureRequests, Honeypot } from './FeatureRequests';
import { Notifications } from './Notifications';
import { ReportButton } from './Moderation';

// External participation (R3-19): customers and partners take part in challenges by portal
// link or invitation. They accept the terms of use and the consent text of each challenge,
// see their own ideas and the released ideas of other participants, and nothing internal.

interface ConsentText {
  id: string;
  version: number;
  body: string;
  accepted?: boolean;
}

interface CustomField {
  id: string;
  label: string;
  type: 'text' | 'number' | 'select';
  options: string[];
  required: boolean;
}

interface ExternalChallenge {
  id: string;
  title: string;
  question: string;
  topic: string | null;
  startsOn: string;
  endsOn: string;
  open: boolean;
  moderation: 'pre' | 'post';
  customFields: CustomField[];
  consent: ConsentText | null;
}

interface Home {
  enabled: boolean;
  terms: ConsentText | null;
  challenges: ExternalChallenge[];
  topics: string[];
  featureRequests: boolean;
  privacyNotice: string;
}

interface ExternalIdeaItem {
  id: string;
  number: number;
  title: string;
  status: string;
  challengeTitle: string | null;
  own: boolean;
  moderation: string | null;
  submittedAt: string | null;
}

/** The invention hint (R3-25): ideas that could be inventions are checked before publication. */
export function InventionHint() {
  return <p className="alert info small" role="note">{t('external.inventionHint')}</p>;
}

function ConsentBody({ text }: { text: ConsentText }) {
  return (
    <div className="pre small consent-text" style={{ maxHeight: 260, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 8, padding: 10 }} tabIndex={0}>
      {text.body}
    </div>
  );
}

function ModerationNote({ moderation }: { moderation: string | null }) {
  if (moderation === 'pending') return <span className="badge yellow">{t('external.moderation.waiting')}</span>;
  if (moderation === 'hidden') return <span className="badge">{t('external.moderation.notPublished')}</span>;
  return null;
}

export function ExternalShell() {
  const { me } = useSession();
  const home = useLoad<Home>('/api/external/home');
  const logout = async () => {
    await api.post('/api/auth/logout');
    window.location.href = '/login';
  };
  return (
    <>
      <a className="skip-link" href="#inhalt">{t('app.skipToContent')}</a>
      <header className="topbar">
        <Link to="/" className="brand">
          Ideenportal<small>{me.tenant.name}</small>{/* texts-ok */}
        </Link>
        <nav className="nav" aria-label={t('app.mainNav')}>
          <NavLink to="/" end>{t('external.nav.home')}</NavLink>
          {home.data?.featureRequests && <NavLink to="/wuensche">{t('external.nav.features')}</NavLink>}
        </nav>
        <div className="topbar-right">
          <LanguageSwitch />
          <Notifications />
          <span className="small muted">{me.user.displayName}</span>
          <button type="button" onClick={logout}>{t('app.logout')}</button>
        </div>
      </header>
      <main id="inhalt" tabIndex={-1}>
        <Routes>
          <Route path="/" element={<ExternalHome home={home} />} />
          <Route path="/extern/einreichen/:challengeId" element={<ExternalSubmit home={home.data} />} />
          <Route path="/extern/ideen/:id" element={<ExternalIdea />} />
          <Route path="/wuensche" element={<FeatureRequests />} />
          <Route path="*" element={<p>{t('app.notFound')}</p>} />
        </Routes>
      </main>
    </>
  );
}

function ConsentCard({ home, onDone }: { home: Home; onDone: () => void }) {
  const open = [
    ...(home.terms && !home.terms.accepted ? [{ text: home.terms, title: t('external.consent.terms', { version: home.terms.version }) }] : []),
    ...home.challenges
      .filter((c) => c.consent && !c.consent.accepted)
      .map((c) => ({ text: c.consent!, title: t('external.consent.challenge', { title: c.title, version: c.consent!.version }) })),
  ];
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const { busy, error, run } = useAction();
  if (!open.length) return null;
  const all = open.every((o) => checked[o.text.id]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (await run(() => api.post('/api/external/consents', { ids: open.map((o) => o.text.id) }))) onDone();
  };
  return (
    <section className="card" aria-labelledby="h-consent">
      <h2 id="h-consent">{t('external.consent.title')}</h2>
      <p className="small muted">{t('external.consent.intro')}</p>
      <form onSubmit={submit}>
        <ErrorBox error={error} />
        {open.map((o) => (
          <div key={o.text.id} style={{ marginBottom: 12 }}>
            <h3>{o.title}</h3>
            <ConsentBody text={o.text} />
            <label className="check field">
              <input type="checkbox" checked={!!checked[o.text.id]} onChange={(e) => setChecked({ ...checked, [o.text.id]: e.target.checked })} />
              <span>{t('external.consent.accept')}</span>
            </label>
          </div>
        ))}
        <InventionHint />
        <button className="primary" disabled={busy || !all}>{t('external.consent.submit')}</button>
      </form>
    </section>
  );
}

function ExternalHome({ home }: { home: ReturnType<typeof useLoad<Home>> }) {
  const ideas = useLoad<ExternalIdeaItem[]>('/api/external/ideas');
  const { data, error, loading, reload } = home;
  if (loading && !data) return <Loading />;
  if (error || !data) return <ErrorBox error={error} />;
  if (!data.enabled) return <div className="alert info">{t('external.home.disabled')}</div>;
  const consentsOpen = (!!data.terms && !data.terms.accepted) || data.challenges.some((c) => c.consent && !c.consent.accepted);
  return (
    <div className="stack">
      <h1>{t('external.home.title')}</h1>
      <p className="muted">{t('external.home.intro')}</p>
      <ConsentCard home={data} onDone={reload} />
      <section className="card" aria-labelledby="h-ext-challenges">
        <h2 id="h-ext-challenges">{t('external.home.challenges')}</h2>
        {data.challenges.length === 0 && <p className="muted">{t('external.home.noChallenges')}</p>}
        <ul className="idea-list">
          {data.challenges.map((c) => (
            <li key={c.id}>
              <strong>{c.title}</strong>
              <p className="small" style={{ margin: '4px 0' }}>{c.question}</p>
              <div className="small muted">
                {t('external.home.period', { from: formatDate(c.startsOn), to: formatDate(c.endsOn) })}
                {' · '}
                {c.moderation === 'pre' ? t('external.home.moderationPre') : t('external.home.moderationPost')}
              </div>
              {c.open && !consentsOpen && (
                <Link className="button primary" to={`/extern/einreichen/${c.id}`} style={{ marginTop: 6 }}>{t('external.home.submit')}</Link>
              )}
              {!c.open && <p className="small muted">{t('external.home.closed')}</p>}
            </li>
          ))}
        </ul>
      </section>
      <section className="card" aria-labelledby="h-ext-ideas">
        <h2 id="h-ext-ideas">{t('external.home.ideas')}</h2>
        <p className="small muted">{t('external.home.ideasHint')}</p>
        {ideas.data && ideas.data.length === 0 && <p className="muted">{t('external.home.noIdeas')}</p>}
        <ul className="idea-list">
          {ideas.data?.map((i) => (
            <li key={i.id}>
              <Link to={`/extern/ideen/${i.id}`}>#{i.number} {i.title}</Link>
              <div className="row small">
                <StatusBadge status={i.status} />
                {i.own && <span className="badge accent">{t('external.home.own')}</span>}
                <ModerationNote moderation={i.moderation} />
                {i.challengeTitle && <span className="muted">{i.challengeTitle}</span>}
              </div>
            </li>
          ))}
        </ul>
      </section>
      <section className="card" aria-labelledby="h-ext-privacy">
        <h2 id="h-ext-privacy">{t('external.home.privacy')}</h2>
        <p className="pre small">{data.privacyNotice}</p>
        <a href="/api/me/export">{t('external.home.export')}</a>
      </section>
    </div>
  );
}

function ExternalSubmit({ home }: { home: Home | null }) {
  const { challengeId } = useParams();
  const navigate = useNavigate();
  const challenge = home?.challenges.find((c) => c.id === challengeId);
  const [form, setForm] = useState({ title: '', problem: '', solution: '', benefit: '', topic: '', confidential: false });
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [website, setWebsite] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const { busy, error, run } = useAction();
  if (!home) return <Loading />;
  if (!challenge) return <ErrorBox error={t('external.submit.noChallenge')} />;
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const r = await run(() =>
      api.post<{ id: string }>(`/api/external/challenges/${challenge.id}/ideas`, {
        ...form,
        topic: form.topic || null,
        customValues: Object.keys(custom).length ? custom : undefined,
        confirmNotReport: confirm,
        boundaryAcknowledged: acknowledged || undefined,
        website: website || undefined,
      }),
    );
    if (r) navigate(`/extern/ideen/${r.id}`, { state: { submitted: true } });
  };
  const boundary = error instanceof ApiError && error.code === 'BOUNDARY_CHECK';
  return (
    <div className="stack">
      <h1>{t('external.submit.title', { title: challenge.title })}</h1>
      <p className="muted">{challenge.question}</p>
      <InventionHint />
      <p className="small muted">{challenge.moderation === 'pre' ? t('external.home.moderationPre') : t('external.home.moderationPost')}</p>
      <form className="card" onSubmit={submit}>
        <ErrorBox error={error} />
        <Field id="x-title" label={t('external.submit.fieldTitle')}>
          <input id="x-title" type="text" value={form.title} maxLength={140} onChange={set('title')} required />
        </Field>
        <Field id="x-problem" label={t('external.submit.fieldProblem')}>
          <textarea id="x-problem" value={form.problem} maxLength={5000} onChange={set('problem')} required />
        </Field>
        <Field id="x-solution" label={t('external.submit.fieldSolution')}>
          <textarea id="x-solution" value={form.solution} maxLength={5000} onChange={set('solution')} required />
        </Field>
        <Field id="x-benefit" label={t('external.submit.fieldBenefit')}>
          <textarea id="x-benefit" value={form.benefit} maxLength={3000} onChange={set('benefit')} required />
        </Field>
        <Field id="x-topic" label={t('external.submit.fieldTopic')}>
          <select id="x-topic" value={form.topic} onChange={set('topic')}>
            <option value="">{t('external.submit.topicDefault')}</option>
            {home.topics.map((tp) => <option key={tp} value={tp}>{tp}</option>)}
          </select>
        </Field>
        {challenge.customFields.map((f) => (
          <Field key={f.id} id={`x-cf-${f.id}`} label={f.required ? `${f.label} *` : f.label}>
            {f.type === 'select' ? (
              <select id={`x-cf-${f.id}`} value={custom[f.id] ?? ''} onChange={(e) => setCustom({ ...custom, [f.id]: e.target.value })} required={f.required}>
                <option value="">–</option>
                {f.options.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            ) : (
              <input id={`x-cf-${f.id}`} type={f.type === 'number' ? 'number' : 'text'} value={custom[f.id] ?? ''} required={f.required}
                onChange={(e) => setCustom({ ...custom, [f.id]: e.target.value })} />
            )}
          </Field>
        ))}
        <label className="check field">
          <input type="checkbox" checked={form.confidential} onChange={(e) => setForm({ ...form, confidential: e.target.checked })} />
          <span>{t('external.submit.confidential')}</span>
        </label>
        <label className="check field">
          <input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} required />
          <span>{t('external.submit.confirmNotReport')}</span>
        </label>
        {boundary && (
          <label className="check field">
            <input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} />
            <span>{t('external.submit.boundaryAck')}</span>
          </label>
        )}
        <Honeypot value={website} onChange={setWebsite} />
        <div className="row">
          <button className="primary" disabled={busy || !confirm}>{t('external.submit.send')}</button>
          <Link to="/" className="button">{t('external.cancel')}</Link>
        </div>
      </form>
    </div>
  );
}

interface ExternalDetail {
  id: string;
  number: number;
  title: string;
  problem: string;
  solution: string;
  benefit: string;
  topic: string | null;
  status: string;
  lane: string | null;
  confidential: boolean;
  moderation: string | null;
  submittedAt: string | null;
  challenge: { id: string; title: string } | null;
  own: boolean;
  questions: { round: number; question: string; answer: string | null; askedOn: string }[];
  decisions: { gate: number; outcome: string; reason: string | null; decidedAt: string }[];
  can: { answer: boolean; report: boolean };
}

function ExternalIdea() {
  const { id } = useParams();
  const location = useLocation();
  const { data: d, error, loading, reload } = useLoad<ExternalDetail>(`/api/external/ideas/${id}`);
  const [answer, setAnswer] = useState('');
  const { busy, error: answerError, run } = useAction();
  if (loading && !d) return <Loading />;
  if (error || !d) return <ErrorBox error={error} />;
  const submitted = (location.state as { submitted?: boolean } | null)?.submitted;
  const send = async (e: FormEvent) => {
    e.preventDefault();
    if (await run(() => api.post(`/api/external/ideas/${d.id}/answer`, { answer }))) {
      setAnswer('');
      await reload();
    }
  };
  return (
    <div className="stack">
      {submitted && <div className="alert success" role="status">{d.moderation === 'pending' ? t('external.idea.thanksPending') : t('external.idea.thanks')}</div>}
      <p className="muted small" style={{ margin: 0 }}>
        #{d.number}{d.challenge && <> · {d.challenge.title}</>}{d.topic && <> · {d.topic}</>}
      </p>
      <h1>{d.title}</h1>
      <div className="row small">
        <StatusBadge status={d.status} />
        {d.own && <span className="badge accent">{t('external.home.own')}</span>}
        {d.confidential && <span className="badge">{t('external.idea.confidential')}</span>}
        <ModerationNote moderation={d.moderation} />
      </div>
      <section className="card">
        <h2>{t('external.submit.fieldProblem')}</h2>
        <p className="pre">{d.problem || '–'}</p>
        <h2>{t('external.submit.fieldSolution')}</h2>
        <p className="pre">{d.solution || '–'}</p>
        <h2>{t('external.submit.fieldBenefit')}</h2>
        <p className="pre">{d.benefit || '–'}</p>
        {d.can.report && <ReportButton ideaId={d.id} />}
      </section>
      {d.questions.length > 0 && (
        <section className="card" aria-labelledby="h-ext-questions">
          <h2 id="h-ext-questions">{t('external.idea.questions')}</h2>
          {d.questions.map((q) => (
            <div key={q.round}>
              <p><strong>{t('external.idea.question', { round: q.round })}</strong> {q.question}</p>
              {q.answer && <p className="pre small">{t('external.idea.answer', { answer: q.answer })}</p>}
            </div>
          ))}
          {d.can.answer && (
            <form onSubmit={send}>
              <ErrorBox error={answerError} />
              <Field id="x-answer" label={t('external.idea.yourAnswer')}>
                <textarea id="x-answer" value={answer} onChange={(e) => setAnswer(e.target.value)} required />
              </Field>
              <button className="primary" disabled={busy || answer.trim().length < 2}>{t('external.idea.sendAnswer')}</button>
            </form>
          )}
        </section>
      )}
      {d.decisions.length > 0 && (
        <section className="card" aria-labelledby="h-ext-decisions">
          <h2 id="h-ext-decisions">{t('external.idea.decisions')}</h2>
          <ul className="idea-list">
            {d.decisions.map((x, n) => (
              <li key={n}>
                <strong>{t('external.idea.gate', { gate: x.gate })}</strong> {(x.gate === 1 ? LANES[x.outcome] : OUTCOMES[x.outcome]) ?? x.outcome}
                <span className="small muted"> · {formatDateTime(x.decidedAt)}</span>
                {x.reason && <p className="pre small">{x.reason}</p>}
              </li>
            ))}
          </ul>
        </section>
      )}
      <Link to="/">{t('external.idea.back')}</Link>
    </div>
  );
}

interface JoinInfo {
  workspace: string;
  challenge: { title: string; question: string };
  terms: ConsentText;
  consent: ConsentText;
  privacyNotice: string;
}

/** Public page of the portal link: sign-up with consent (R3-19). */
export function ExternalJoin({ onLoggedIn }: { onLoggedIn(): Promise<void> }) {
  const { code } = useParams();
  const navigate = useNavigate();
  const { data, error: loadError, loading } = useLoad<JoinInfo>(`/api/external/join/${code}`);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [terms, setTerms] = useState(false);
  const [consent, setConsent] = useState(false);
  const [website, setWebsite] = useState('');
  const { busy, error, run, setError } = useAction();
  const { busy: joinBusy, error: joinError, run: runJoin } = useAction();

  // Somebody with an external account of this workspace takes part in one more challenge.
  const joinWithAccount = async () => {
    try {
      await api.post(`/api/external/access/${code}`);
      await onLoggedIn();
      navigate('/');
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) navigate(`/login?weiter=${encodeURIComponent(`/mitmachen/${code}`)}`);
      else await runJoin(() => Promise.reject(e));
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!data) return;
    if (!terms || !consent) return setError(new ApiError(400, t('external.join.acceptRequired')));
    const ok = await run(() =>
      api.post(`/api/external/join/${code}`, {
        name, email, password, termsId: data.terms.id, consentId: data.consent.id, acceptTerms: true, acceptConsent: true, website: website || undefined,
      }),
    );
    if (ok) {
      await onLoggedIn();
      navigate('/');
    }
  };

  return (
    <main className="login-wrap" id="inhalt">
      <div className="card" style={{ maxWidth: 720 }}>
        {loading && !data ? (
          <Loading />
        ) : loadError || !data ? (
          <>
            <h1>{t('external.join.invalidTitle')}</h1>
            <ErrorBox error={loadError ?? t('external.join.invalidTitle')} />
            <Link to="/login">{t('external.join.toLogin')}</Link>
          </>
        ) : (
          <>
            <p className="muted small" style={{ margin: 0 }}>{data.workspace}</p>
            <h1>{t('external.join.title', { title: data.challenge.title })}</h1>
            <p>{data.challenge.question}</p>
            <p className="small muted">{t('external.join.intro')}</p>
            <form onSubmit={submit} noValidate>
              <ErrorBox error={error} />
              <Field id="x-name" label={t('external.join.name')}>
                <input id="x-name" type="text" value={name} onChange={(e) => setName(e.target.value)} required autoComplete="name" />
              </Field>
              <Field id="x-email" label={t('external.join.email')}>
                <input id="x-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
              </Field>
              <Field id="x-password" label={t('external.join.password')} hint={t('external.join.passwordHint')}>
                <input id="x-password" type="password" value={password} minLength={10} onChange={(e) => setPassword(e.target.value)} required autoComplete="new-password" aria-describedby="x-password-hint" />
              </Field>
              <h2>{t('external.join.terms', { version: data.terms.version })}</h2>
              <ConsentBody text={data.terms} />
              <label className="check field">
                <input type="checkbox" checked={terms} onChange={(e) => setTerms(e.target.checked)} required />
                <span>{t('external.join.acceptTerms')}</span>
              </label>
              <h2>{t('external.join.consent', { version: data.consent.version })}</h2>
              <ConsentBody text={data.consent} />
              <label className="check field">
                <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} required />
                <span>{t('external.join.acceptConsent')}</span>
              </label>
              <InventionHint />
              <details>
                <summary className="small">{t('external.join.privacy')}</summary>
                <p className="pre small">{data.privacyNotice}</p>
              </details>
              <Honeypot value={website} onChange={setWebsite} />
              <button className="primary" disabled={busy}>{t('external.join.submit')}</button>
            </form>
            <section aria-labelledby="h-have-account" style={{ marginTop: 16 }}>
              <h2 id="h-have-account">{t('external.join.haveAccount')}</h2>
              <p className="small muted">{t('external.join.haveAccountText')}</p>
              <ErrorBox error={joinError} />
              <button type="button" disabled={joinBusy} onClick={joinWithAccount}>{t('external.join.withAccount')}</button>
            </section>
          </>
        )}
      </div>
      <LanguageSwitch />
    </main>
  );
}
