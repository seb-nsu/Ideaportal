import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { Dialog, ErrorBox, Field, Loading, useAction, useLoad } from '../components';
import { formatDateTime, labelMap, t } from '../i18n';

// Moderation (R3-21): external posts waiting for release and reported ideas and comments.
// Reporters stay anonymous; the queue shows the content and the reason only.

const REASONS = ['spam', 'offensive', 'confidential', 'other'] as const;
const reasonLabel = () => labelMap('external.reason', REASONS);

/** "Melden" for an idea or a comment; opens a small dialog with reason and note. */
export function ReportButton({ ideaId, commentId, compact = false }: { ideaId: string; commentId?: string; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState(false);
  const [reason, setReason] = useState<(typeof REASONS)[number]>('spam');
  const [note, setNote] = useState('');
  const { busy, error, run } = useAction();
  const labels = reasonLabel();
  const fieldId = `report-${commentId ?? ideaId}`;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (await run(() => api.post(`/api/ideas/${ideaId}/report`, { reason, note: note.trim() || undefined, commentId }))) {
      setDone(true);
      setOpen(false);
    }
  };
  if (done) return <span className="small muted" role="status">{t('external.report.thanks')}</span>;
  return (
    <>
      <button type="button" className={compact ? 'link small' : 'small'} onClick={() => setOpen(true)}>
        {commentId ? t('external.report.comment') : t('external.report.idea')}
      </button>
      {open && (
        <Dialog title={commentId ? t('external.report.commentTitle') : t('external.report.ideaTitle')} onClose={() => setOpen(false)}>
          <form onSubmit={submit}>
            <ErrorBox error={error} />
            <p className="small muted">{t('external.report.hint')}</p>
            <Field id={`${fieldId}-reason`} label={t('external.report.reason')}>
              <select id={`${fieldId}-reason`} value={reason} onChange={(e) => setReason(e.target.value as (typeof REASONS)[number])}>
                {REASONS.map((r) => <option key={r} value={r}>{labels[r]}</option>)}
              </select>
            </Field>
            <Field id={`${fieldId}-note`} label={t('external.report.note')}>
              <textarea id={`${fieldId}-note`} value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} />
            </Field>
            <div className="row">
              <button className="primary" disabled={busy}>{t('external.report.send')}</button>
              <button type="button" onClick={() => setOpen(false)}>{t('external.cancel')}</button>
            </div>
          </form>
        </Dialog>
      )}
    </>
  );
}

interface Queue {
  pending: { id: string; number: number; title: string; excerpt: string; origin: string; submittedAt: string | null; challengeTitle: string | null }[];
  reports: {
    id: string; reason: string; note: string | null; createdAt: string; ideaId: string; number: number; title: string;
    moderation: string | null; commentId: string | null; commentBody: string | null;
  }[];
}

export function Moderation() {
  const { data, error, loading, reload } = useLoad<Queue>('/api/moderation');
  const { busy, error: actionError, run } = useAction();
  const labels = reasonLabel();
  const act = async (url: string, action: string) => {
    if (await run(() => api.post(url, { action }))) await reload();
  };
  if (loading && !data) return <Loading />;
  if (error || !data) return <ErrorBox error={error} />;
  return (
    <div className="stack">
      <h1>{t('external.moderation.title')}</h1>
      <p className="muted">{t('external.moderation.intro')}</p>
      <ErrorBox error={actionError} />
      <section className="card" aria-labelledby="h-pending">
        <h2 id="h-pending">{t('external.moderation.pending', { n: data.pending.length })}</h2>
        {data.pending.length === 0 && <p className="muted">{t('external.moderation.noPending')}</p>}
        <ul className="idea-list">
          {data.pending.map((i) => (
            <li key={i.id}>
              <Link to={`/ideen/${i.id}`}>#{i.number} {i.title}</Link>
              <div className="small muted">
                {i.challengeTitle ?? '–'}{i.submittedAt && <> · {formatDateTime(i.submittedAt)}</>}
              </div>
              <p className="pre small">{i.excerpt}</p>
              <div className="row">
                <button type="button" className="primary" disabled={busy} onClick={() => act(`/api/moderation/ideas/${i.id}`, 'approve')}>{t('external.moderation.approve')}</button>
                <button type="button" disabled={busy} onClick={() => act(`/api/moderation/ideas/${i.id}`, 'hide')}>{t('external.moderation.hide')}</button>
              </div>
            </li>
          ))}
        </ul>
      </section>
      <section className="card" aria-labelledby="h-reports">
        <h2 id="h-reports">{t('external.moderation.reports', { n: data.reports.length })}</h2>
        {data.reports.length === 0 && <p className="muted">{t('external.moderation.noReports')}</p>}
        <ul className="idea-list">
          {data.reports.map((r) => (
            <li key={r.id}>
              <div className="row small">
                <span className="badge yellow">{labels[r.reason] ?? r.reason}</span>
                <span className="muted">{formatDateTime(r.createdAt)}</span>
                {r.moderation === 'hidden' && <span className="badge">{t('external.moderation.hidden')}</span>}
              </div>
              <Link to={`/ideen/${r.ideaId}`}>#{r.number} {r.title}</Link>
              {r.commentId && (
                <p className="pre small"><strong>{t('external.moderation.comment')}</strong> {r.commentBody}</p>
              )}
              {r.note && <p className="small">{t('external.moderation.note', { note: r.note })}</p>}
              <div className="row">
                <button type="button" disabled={busy} onClick={() => act(`/api/moderation/reports/${r.id}`, 'hide')}>
                  {r.commentId ? t('external.moderation.hideComment') : t('external.moderation.hide')}
                </button>
                <button type="button" disabled={busy} onClick={() => act(`/api/moderation/reports/${r.id}`, 'dismiss')}>{t('external.moderation.dismiss')}</button>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
