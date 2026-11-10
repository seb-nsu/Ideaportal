import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api';
import { ErrorBox, Field, useAction } from '../../components';
import { formatDateTime, t } from '../../i18n';
import { useSession } from '../../session';

// Problem exchange (R3-31): solutions proposed by the community, and the triage step
// that turns a problem into a challenge.

interface Solution {
  id: string;
  body: string;
  createdAt: string;
  authorName: string;
}

export function ProblemSolutions({ ideaId, solutions, canPropose, onDone }: { ideaId: string; solutions: Solution[]; canPropose: boolean; onDone: () => void }) {
  const [body, setBody] = useState('');
  const { busy, error, run } = useAction();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (await run(() => api.post(`/api/ideas/${ideaId}/comments`, { body, kind: 'solution' }))) {
      setBody('');
      onDone();
    }
  };
  return (
    <section className="card" aria-labelledby="h-solutions">
      <h2 id="h-solutions">{t('usecases.problem.solutions', { n: solutions.length })}</h2>
      <p className="small muted">{t('usecases.problem.solutionsIntro')}</p>
      {solutions.length === 0 ? <p className="muted">{t('usecases.problem.noSolutions')}</p> : (
        <ul className="idea-list">
          {solutions.map((s) => (
            <li key={s.id} id={`comment-${s.id}`}>
              <div className="small muted">{s.authorName} · {formatDateTime(s.createdAt)}</div>
              <p className="pre">{s.body}</p>
            </li>
          ))}
        </ul>
      )}
      {canPropose && (
        <form onSubmit={submit}>
          <ErrorBox error={error} />
          <Field id="solution-proposal" label={t('usecases.problem.propose')}>
            <textarea id="solution-proposal" value={body} onChange={(e) => setBody(e.target.value)} maxLength={3000} required />
          </Field>
          <button className="primary" disabled={busy || !body.trim()}>{t('usecases.problem.proposeSend')}</button>
        </form>
      )}
    </section>
  );
}

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Gate 1 for a problem: make it a challenge (status "forwarded" to the challenge). Merging uses the merge panel. */
export function ProblemToChallenge({ idea }: { idea: { id: string; title: string; problem: string } }) {
  const { settings } = useSession();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ title: idea.title, question: '', endsOn: addDays(settings.today, 42), reason: '' });
  const [created, setCreated] = useState<string | null>(null);
  const { busy, error, run } = useAction();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const r = await run(() => api.post<{ challengeId: string }>(`/api/ideas/${idea.id}/to-challenge`, { ...form, reason: form.reason || undefined }));
    if (r) setCreated(r.challengeId);
  };
  return (
    <section className="card" aria-labelledby="h-to-challenge">
      <h2 id="h-to-challenge">{t('usecases.toChallenge.title')}</h2>
      <p className="small muted">{t('usecases.toChallenge.intro')}</p>
      {created ? (
        <p className="alert success" role="status">
          {t('usecases.toChallenge.done')} <Link to={`/challenges/${created}`}>{t('usecases.toChallenge.open')}</Link>
        </p>
      ) : !open ? (
        <button type="button" onClick={() => { setForm({ ...form, question: t('usecases.toChallenge.questionTemplate', { title: idea.title }) }); setOpen(true); }}>
          {t('usecases.toChallenge.start')}
        </button>
      ) : (
        <form onSubmit={submit}>
          <ErrorBox error={error} />
          <Field id="tc-title" label={t('usecases.toChallenge.name')}>
            <input id="tc-title" type="text" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} maxLength={140} required />
          </Field>
          <Field id="tc-question" label={t('usecases.toChallenge.question')}>
            <textarea id="tc-question" value={form.question} onChange={(e) => setForm({ ...form, question: e.target.value })} required />
          </Field>
          <Field id="tc-end" label={t('usecases.toChallenge.end')}>
            <input id="tc-end" type="date" value={form.endsOn} min={settings.today} onChange={(e) => setForm({ ...form, endsOn: e.target.value })} required />
          </Field>
          <Field id="tc-reason" label={t('usecases.toChallenge.reason')}>
            <textarea id="tc-reason" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
          </Field>
          <div className="row">
            <button type="button" onClick={() => setOpen(false)}>{t('usecases.cancel')}</button>
            <button className="primary" disabled={busy}>{t('usecases.toChallenge.submit')}</button>
          </div>
        </form>
      )}
    </section>
  );
}
