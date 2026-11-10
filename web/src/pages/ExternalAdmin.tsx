import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { ErrorBox, Field, Loading, useAction, useLoad } from '../components';
import { formatDate, formatDateTime, t } from '../i18n';
import { hasRole, useSession } from '../session';

// Administration of external participation (R3-19, R3-21) and of the feature-request module
// (R3-20): tenant switch and moderation default, versioned terms of use, per challenge the
// portal link, moderation, consent text and invitations, and the consent log.

interface Text {
  id: string;
  version: number;
  body: string;
  createdAt: string;
}

interface AdminChallenge {
  id: string;
  title: string;
  startsOn: string;
  endsOn: string;
  externalEnabled: boolean;
  link: string | null;
  moderation: 'pre' | 'post' | null;
  effectiveModeration: 'pre' | 'post';
  consent: Text | null;
  participants: number;
  pending: number;
}

interface Overview {
  settings: { enabled: boolean; moderation: 'pre' | 'post'; maxLinks: number };
  terms: Text | null;
  challenges: AdminChallenge[];
}

function NewVersion({ current, url, onDone, id }: { current: Text | null; url: string; onDone: () => void; id: string }) {
  const [body, setBody] = useState(current?.body ?? '');
  const { busy, error, run } = useAction();
  useEffect(() => setBody(current?.body ?? ''), [current?.id]);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (await run(() => api.post(url, { body }))) onDone();
  };
  return (
    <form onSubmit={save}>
      <ErrorBox error={error} />
      <Field id={id} label={t('external.admin.textLabel', { version: current?.version ?? 0 })} hint={t('external.admin.textHint')}>
        <textarea id={id} rows={8} value={body} maxLength={20000} onChange={(e) => setBody(e.target.value)} aria-describedby={`${id}-hint`} />
      </Field>
      <button disabled={busy || body.trim().length < 20 || body === current?.body}>{t('external.admin.saveVersion')}</button>
    </form>
  );
}

function Invite({ challengeId }: { challengeId: string }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [link, setLink] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const { busy, error, run } = useAction();
  const invite = async (e: FormEvent) => {
    e.preventDefault();
    const r = await run(() => api.post<{ id: string; inviteLink?: string }>(`/api/admin/external/challenges/${challengeId}/invitations`, { name, email }));
    if (r) {
      setLink(r.inviteLink ?? null);
      setSent(true);
      setName('');
      setEmail('');
    }
  };
  return (
    <form onSubmit={invite} className="stack">
      <ErrorBox error={error} />
      <div className="grid grid-2">
        <Field id={`inv-name-${challengeId}`} label={t('external.admin.inviteName')}>
          <input id={`inv-name-${challengeId}`} type="text" value={name} onChange={(e) => setName(e.target.value)} required />
        </Field>
        <Field id={`inv-email-${challengeId}`} label={t('external.admin.inviteEmail')}>
          <input id={`inv-email-${challengeId}`} type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </Field>
      </div>
      <div className="row">
        <button disabled={busy || !email || name.trim().length < 2}>{t('external.admin.invite')}</button>
        {sent && <span className="small" role="status">{t('external.admin.invited')}</span>}
      </div>
      {link && <p className="small">{t('external.admin.inviteLink')} <code>{link}</code></p>}
    </form>
  );
}

function ChallengeRow({ c, onDone, canEdit }: { c: AdminChallenge; onDone: () => void; canEdit: boolean }) {
  const { busy, error, run } = useAction();
  const patch = async (body: Record<string, unknown>) => {
    if (await run(() => api.patch(`/api/admin/external/challenges/${c.id}`, body))) onDone();
  };
  return (
    <li>
      <div className="row spread">
        <strong>{c.title}</strong>
        <span className="small muted">{formatDate(c.startsOn)} – {formatDate(c.endsOn)}</span>
      </div>
      <ErrorBox error={error} />
      <label className="check field">
        <input type="checkbox" checked={c.externalEnabled} disabled={busy || !canEdit} onChange={(e) => patch({ externalEnabled: e.target.checked })} />
        <span>{t('external.admin.challengeOpen')}</span>
      </label>
      {c.externalEnabled && (
        <div className="stack">
          {c.link && (
            <div className="row small">
              <label htmlFor={`link-${c.id}`}>{t('external.admin.portalLink')}</label>
              <input id={`link-${c.id}`} type="text" readOnly value={c.link} onFocus={(e) => e.target.select()} style={{ flex: 1, minWidth: 0 }} />
              <button type="button" disabled={busy} onClick={() => patch({ newLink: true })}>{t('external.admin.newLink')}</button>
            </div>
          )}
          <div className="row small">
            <label htmlFor={`mod-${c.id}`}>{t('external.admin.moderation')}</label>
            <select id={`mod-${c.id}`} value={c.moderation ?? ''} disabled={busy} onChange={(e) => patch({ moderation: e.target.value || null })}>
              <option value="">{t('external.admin.moderationDefault')}</option>
              <option value="pre">{t('external.admin.moderationPre')}</option>
              <option value="post">{t('external.admin.moderationPost')}</option>
            </select>
          </div>
          <p className="small muted">
            {t('external.admin.participants', { n: c.participants })}
            {c.pending > 0 && <> · <Link to="/moderation">{t('external.admin.pending', { n: c.pending })}</Link></>}
          </p>
          <details>
            <summary>{t('external.admin.consentText', { version: c.consent?.version ?? 0 })}</summary>
            <NewVersion id={`consent-${c.id}`} current={c.consent} url={`/api/admin/external/challenges/${c.id}/consent`} onDone={onDone} />
          </details>
          <details>
            <summary>{t('external.admin.inviteTitle')}</summary>
            <Invite challengeId={c.id} />
          </details>
        </div>
      )}
    </li>
  );
}

function ConsentLog() {
  const { data, error, loading } = useLoad<{ acceptedAt: string; name: string; email: string; kind: string; version: number; challengeTitle: string | null }[]>('/api/admin/external/consents');
  if (loading && !data) return <Loading />;
  if (error || !data) return <ErrorBox error={error} />;
  if (!data.length) return <p className="muted">{t('external.admin.logEmpty')}</p>;
  return (
    <div className="table-wrap" tabIndex={0}>
      <table>
        <thead>
          <tr>
            <th scope="col">{t('external.admin.logWhen')}</th>
            <th scope="col">{t('external.admin.logWho')}</th>
            <th scope="col">{t('external.admin.logText')}</th>
            <th scope="col">{t('external.admin.logVersion')}</th>
          </tr>
        </thead>
        <tbody>
          {data.map((r, n) => (
            <tr key={n}>
              <td>{formatDateTime(r.acceptedAt)}</td>
              <td>{r.name} <span className="small muted">{r.email}</span></td>
              <td>{r.kind === 'terms' ? t('external.admin.logTerms') : t('external.admin.logChallenge', { title: r.challengeTitle ?? '–' })}</td>
              <td>{r.version}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FeatureModule({ initial }: { initial: { enabled: boolean; publicPage: boolean } }) {
  const [value, setValue] = useState(initial);
  const [saved, setSaved] = useState(false);
  const { busy, error, run } = useAction();
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setSaved(false);
    if (await run(() => api.put('/api/admin/feature-requests', value))) setSaved(true);
  };
  return (
    <form onSubmit={save}>
      <ErrorBox error={error} />
      <label className="check field">
        <input type="checkbox" checked={value.enabled} onChange={(e) => setValue({ ...value, enabled: e.target.checked })} />
        <span>{t('external.admin.featuresEnabled')}</span>
      </label>
      <label className="check field">
        <input type="checkbox" checked={value.publicPage} onChange={(e) => setValue({ ...value, publicPage: e.target.checked })} />
        <span>{t('external.admin.featuresPublic')}</span>
      </label>
      <div className="row">
        <button disabled={busy}>{t('external.save')}</button>
        {saved && <span className="small" role="status">{t('external.admin.saved')}</span>}
      </div>
    </form>
  );
}

export function ExternalAdmin() {
  const { me } = useSession();
  const admin = hasRole(me, 'admin');
  const { data, error, loading, reload } = useLoad<Overview>('/api/admin/external');
  const settings = useLoad<{ featureRequests: { enabled: boolean; publicPage: boolean } }>(admin ? '/api/admin/settings' : null);
  const [form, setForm] = useState<Overview['settings'] | null>(null);
  const { busy, error: saveError, run } = useAction();
  useEffect(() => {
    if (data) setForm(data.settings);
  }, [data]);
  if (loading && !data) return <Loading />;
  if (error || !data || !form) return <ErrorBox error={error} />;
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (await run(() => api.put('/api/admin/external', form))) await reload();
  };
  return (
    <div className="stack">
      <h1>{t('external.admin.title')}</h1>
      <p className="muted">{t('external.admin.intro')}</p>
      <p className="alert warn small">{t('external.admin.legalHint')}</p>
      <section className="card" aria-labelledby="h-ext-settings">
        <h2 id="h-ext-settings">{t('external.admin.settings')}</h2>
        <form onSubmit={save}>
          <ErrorBox error={saveError} />
          <label className="check field">
            <input type="checkbox" checked={form.enabled} disabled={!admin} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
            <span>{t('external.admin.enabled')}</span>
          </label>
          <div className="grid grid-2">
            <Field id="ext-moderation" label={t('external.admin.moderationDefaultLabel')}>
              <select id="ext-moderation" value={form.moderation} disabled={!admin} onChange={(e) => setForm({ ...form, moderation: e.target.value as 'pre' | 'post' })}>
                <option value="pre">{t('external.admin.moderationPre')}</option>
                <option value="post">{t('external.admin.moderationPost')}</option>
              </select>
            </Field>
            <Field id="ext-links" label={t('external.admin.maxLinks')} hint={t('external.admin.maxLinksHint')}>
              <input id="ext-links" type="number" min={0} max={20} value={form.maxLinks} disabled={!admin} aria-describedby="ext-links-hint"
                onChange={(e) => setForm({ ...form, maxLinks: Number(e.target.value) })} />
            </Field>
          </div>
          {admin && <button className="primary" disabled={busy}>{t('external.save')}</button>}
        </form>
      </section>
      <section className="card" aria-labelledby="h-ext-terms">
        <h2 id="h-ext-terms">{t('external.admin.terms')}</h2>
        {!data.terms && <p className="muted">{t('external.admin.termsNone')}</p>}
        {admin ? (
          <NewVersion id="ext-terms" current={data.terms} url="/api/admin/external/terms" onDone={reload} />
        ) : (
          data.terms && <p className="pre small">{data.terms.body}</p>
        )}
      </section>
      <section className="card" aria-labelledby="h-ext-challenges">
        <h2 id="h-ext-challenges">{t('external.admin.challenges')}</h2>
        {!data.settings.enabled && <p className="small muted">{t('external.admin.switchOnFirst')}</p>}
        {data.challenges.length === 0 && <p className="muted">{t('external.admin.noChallenges')}</p>}
        <ul className="idea-list">
          {data.challenges.map((c) => <ChallengeRow key={c.id} c={c} onDone={reload} canEdit={data.settings.enabled || c.externalEnabled} />)}
        </ul>
      </section>
      {admin && (
        <section className="card" aria-labelledby="h-ext-log">
          <h2 id="h-ext-log">{t('external.admin.log')}</h2>
          <p className="small muted">{t('external.admin.logHint')}</p>
          <ConsentLog />
        </section>
      )}
      {admin && settings.data && (
        <section className="card" aria-labelledby="h-ext-features">
          <h2 id="h-ext-features">{t('external.admin.features')}</h2>
          <p className="small muted">{t('external.admin.featuresHint')}</p>
          <FeatureModule initial={settings.data.featureRequests} />
        </section>
      )}
    </div>
  );
}
