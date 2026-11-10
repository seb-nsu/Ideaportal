import { useEffect, useState, type FormEvent } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api';
import { ErrorBox, Field, Loading, useAction, useLoad } from '../components';
import { formatDate, labelMap, t } from '../i18n';
import { LanguageSwitch } from '../LanguageSwitch';

// Feature requests with voting (R3-20) and the public status page per workspace. One vote per
// person; the public page shows no names.

const STATUSES = ['new', 'planned', 'in_progress', 'done', 'declined'] as const;
type FeatureStatus = (typeof STATUSES)[number];
const statusLabel = () => labelMap('external.feature.status', STATUSES);
const TONE: Record<FeatureStatus, string> = { new: '', planned: 'accent', in_progress: 'yellow', done: 'green', declined: 'red' };

interface Item {
  id: string;
  number: number;
  title: string;
  description: string;
  status: FeatureStatus;
  statusNote: string | null;
  votes: number;
  votedByMe: boolean;
  mine: boolean;
  updatedAt: string;
}

function StatusEditor({ item, onDone }: { item: Item; onDone: () => void }) {
  const [status, setStatus] = useState<FeatureStatus>(item.status);
  const [note, setNote] = useState(item.statusNote ?? '');
  const { busy, error, run } = useAction();
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (await run(() => api.patch(`/api/feature-requests/${item.id}`, { status, note }))) onDone();
  };
  const labels = statusLabel();
  return (
    <form onSubmit={save} className="row small" style={{ marginTop: 8 }}>
      <ErrorBox error={error} />
      <label htmlFor={`fr-status-${item.id}`}>{t('external.feature.statusLabel')}</label>
      <select id={`fr-status-${item.id}`} value={status} onChange={(e) => setStatus(e.target.value as FeatureStatus)}>
        {STATUSES.map((s) => <option key={s} value={s}>{labels[s]}</option>)}
      </select>
      <label htmlFor={`fr-note-${item.id}`} className="sr-only">{t('external.feature.noteLabel')}</label>
      <input id={`fr-note-${item.id}`} type="text" value={note} maxLength={1000} placeholder={t('external.feature.notePlaceholder')} onChange={(e) => setNote(e.target.value)} />
      <button disabled={busy}>{t('external.save')}</button>
    </form>
  );
}

export function FeatureRequests() {
  const { data, error, loading, reload } = useLoad<{ items: Item[]; canManage: boolean; publicUrl: string | null }>('/api/feature-requests');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [website, setWebsite] = useState('');
  const { busy, error: actionError, run } = useAction();
  const labels = statusLabel();

  const create = async (e: FormEvent) => {
    e.preventDefault();
    if (await run(() => api.post('/api/feature-requests', { title, description, website: website || undefined }))) {
      setTitle('');
      setDescription('');
      await reload();
    }
  };
  const vote = async (item: Item) => {
    if (await run(() => (item.votedByMe ? api.del(`/api/feature-requests/${item.id}/vote`) : api.post(`/api/feature-requests/${item.id}/vote`)))) await reload();
  };

  if (loading && !data) return <Loading />;
  if (error || !data) return <ErrorBox error={error} />;
  return (
    <div className="stack">
      <h1>{t('external.feature.title')}</h1>
      <p className="muted">{t('external.feature.intro')}</p>
      {data.publicUrl && (
        <p className="small">
          {t('external.feature.publicPage')} <a href={data.publicUrl}>{data.publicUrl}</a>
        </p>
      )}
      <section className="card" aria-labelledby="h-fr-new">
        <h2 id="h-fr-new">{t('external.feature.newTitle')}</h2>
        <form onSubmit={create}>
          <ErrorBox error={actionError} />
          <Field id="fr-title" label={t('external.feature.fieldTitle')}>
            <input id="fr-title" type="text" value={title} maxLength={140} onChange={(e) => setTitle(e.target.value)} required />
          </Field>
          <Field id="fr-description" label={t('external.feature.fieldDescription')}>
            <textarea id="fr-description" value={description} maxLength={3000} onChange={(e) => setDescription(e.target.value)} />
          </Field>
          <Honeypot value={website} onChange={setWebsite} />
          <button className="primary" disabled={busy || title.trim().length < 3}>{t('external.feature.submit')}</button>
        </form>
      </section>
      <section className="card" aria-labelledby="h-fr-list">
        <h2 id="h-fr-list">{t('external.feature.listTitle', { n: data.items.length })}</h2>
        {data.items.length === 0 && <p className="muted">{t('external.feature.empty')}</p>}
        <ul className="idea-list">
          {data.items.map((f) => (
            <li key={f.id}>
              <div className="row spread">
                <strong>#{f.number} {f.title}</strong>
                <span className={`badge ${TONE[f.status]}`}>{labels[f.status]}</span>
              </div>
              {f.description && <p className="pre small">{f.description}</p>}
              {f.statusNote && <p className="small">{t('external.feature.statusNote', { note: f.statusNote })}</p>}
              <div className="row small">
                <button type="button" aria-pressed={f.votedByMe} disabled={busy} onClick={() => vote(f)}>
                  {f.votedByMe ? t('external.feature.unvote') : t('external.feature.vote')}
                </button>
                <span className="muted">{t('external.feature.votes', { n: f.votes })}</span>
              </div>
              {data.canManage && <StatusEditor item={f} onDone={reload} />}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

/** Hidden field against bots (R3-21): people do not see it, bots fill it in. */
export function Honeypot({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="sr-only" aria-hidden="true">
      <label htmlFor="hp-website">{t('external.honeypot')}</label>
      <input id="hp-website" type="text" name="website" tabIndex={-1} autoComplete="off" value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

interface PublicItem {
  number: number;
  title: string;
  description: string;
  status: FeatureStatus;
  statusNote: string | null;
  votes: number;
  updatedAt: string;
}

/** Public status page of a workspace: /status/:slug, no sign-in. */
export function FeatureStatusPage() {
  const { slug } = useParams();
  const { data, error, loading } = useLoad<{ workspace: string; items: PublicItem[] }>(`/api/public/feature-requests/${slug}`);
  useEffect(() => {
    if (data) document.title = t('external.status.docTitle', { name: data.workspace });
  }, [data]);
  const labels = statusLabel();
  return (
    <main className="login-wrap" id="inhalt">
      <div className="card" style={{ maxWidth: 820 }}>
        {loading && !data ? (
          <Loading />
        ) : error || !data ? (
          <ErrorBox error={error ?? t('external.status.notFound')} />
        ) : (
          <>
            <h1>{t('external.status.title', { name: data.workspace })}</h1>
            <p className="muted">{t('external.status.intro')}</p>
            {data.items.length === 0 && <p className="muted">{t('external.feature.empty')}</p>}
            {(['in_progress', 'planned', 'done', 'declined'] as const).map((s) => {
              const items = data.items.filter((i) => i.status === s);
              if (!items.length) return null;
              return (
                <section key={s} aria-labelledby={`h-status-${s}`}>
                  <h2 id={`h-status-${s}`}>{labels[s]}</h2>
                  <ul className="idea-list">
                    {items.map((i) => (
                      <li key={i.number}>
                        <strong>#{i.number} {i.title}</strong>
                        {i.description && <p className="pre small">{i.description}</p>}
                        {i.statusNote && <p className="small">{t('external.feature.statusNote', { note: i.statusNote })}</p>}
                        <div className="small muted">{t('external.feature.votes', { n: i.votes })} · {t('external.status.updated', { date: formatDate(i.updatedAt) })}</div>
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
          </>
        )}
      </div>
      <LanguageSwitch />
    </main>
  );
}
