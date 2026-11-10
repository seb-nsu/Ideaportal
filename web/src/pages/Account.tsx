import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, type UserRef } from '../api';
import { ErrorBox, Field, Loading, UserPicker, useAction, useLoad } from '../components';
import { ROLES } from '../labels';
import { formatDate, getLocale, labelMap, setLocale, t, tn, type Locale } from '../i18n';
import { isStaff, useSession } from '../session';
import { ChatPreferences } from './ChatSettings';
import { useFeature } from '../plan';

// "Mein Konto": absences and deputies (R1-11), notification settings (R1-36), own data (R1-40).

interface Absence {
  id: string;
  startsOn: string;
  endsOn: string;
  note: string | null;
  mine: boolean;
  userName: string;
  deputyName: string;
}

type AccountTab = 'profile' | 'notifications' | 'absence' | 'data';
const TAB_LABEL = labelMap('account.tab', ['profile', 'notifications', 'absence', 'data'] as const);

// trends: weekly trend hints for sponsors (R4-02); unticking it unsubscribes completely, also from the inbox.
const CATEGORY_LABEL = labelMap('account.category', ['my_ideas', 'community', 'tasks', 'reminders', 'trends'] as const);

export function Account() {
  const { me } = useSession();
  // Slack and Teams only when the package includes them (R3-05).
  const chat = useFeature('chat');
  // Sections as tabs; absence and deputy matter most for people with tasks, so it comes later for others.
  const tabs: AccountTab[] = isStaff(me) ? ['profile', 'notifications', 'absence', 'data'] : ['profile', 'notifications', 'data', 'absence'];
  const [tab, setTab] = useState<AccountTab>('profile');
  // On phones the account menu of the top bar is hidden; help and sign-out live here.
  const logout = async () => {
    await api.post('/api/auth/logout');
    window.location.href = me.demo ? '/' : '/login';
  };
  return (
    <div className="stack">
      <h1>{t('account.title')}</h1>
      <div className="row only-mobile">
        <Link to="/hilfe">{t('app.nav.help')}</Link> · <button type="button" className="link" onClick={logout}>{t('app.logout')}</button>
      </div>
      <section className="card">
        <p style={{ margin: 0 }}>
          <strong>{me.user.displayName}</strong> · {me.user.email} · {me.tenant.name}
        </p>
        <p className="small muted" style={{ margin: 0 }}>
          {t('account.roles', { roles: me.user.roles.map((r) => ROLES[r]).join(', ') })} · {me.user.mfaEnabled ? t('account.mfaActive') : t('account.mfaMissing')}
        </p>
      </section>
      <div className="tabs" role="tablist" aria-label={t('account.tabs')}>
        {tabs.map((k) => (
          <button key={k} type="button" role="tab" id={`acc-tab-${k}`} aria-selected={tab === k} aria-controls="acc-panel" onClick={() => setTab(k)}>{TAB_LABEL[k]}</button>
        ))}
      </div>
      <div className="stack" role="tabpanel" id="acc-panel" aria-labelledby={`acc-tab-${tab}`}>
        {tab === 'profile' && <Language />}
        {tab === 'notifications' && (
          <div className="grid grid-2">
            <Preferences />
            {chat && <ChatPreferences />}
          </div>
        )}
        {tab === 'absence' && <Absences />}
        {tab === 'data' && (
          <>
            <Recognition />
            <section className="card" aria-labelledby="h-data">
              <h2 id="h-data">{t('account.data.title')}</h2>
              <p>{t('account.data.intro')}</p>
              <a className="button" href="/api/me/export" download="meine-daten.json">{t('account.data.download')}</a>
              <p className="small muted" style={{ marginTop: 10 }}>{t('account.data.delete')}</p>
            </section>
          </>
        )}
      </div>
    </div>
  );
}

/** Language per person (R2-50): interface, mails and server messages follow it. */
function Language() {
  const { refresh } = useSession();
  const { busy, error, run } = useAction();
  const change = async (locale: Locale) => {
    const ok = await run(() => api.put('/api/me/locale', { locale }));
    if (ok === undefined) return;
    setLocale(locale);
    await refresh();
  };
  return (
    <section className="card" aria-labelledby="h-language">
      <h2 id="h-language">{t('account.language.title')}</h2>
      <Field id="locale" label={t('account.language.label')} hint={t('account.language.hint')}>
        <select id="locale" value={getLocale()} disabled={busy} onChange={(e) => void change(e.target.value as Locale)}>
          <option value="de" lang="de">Deutsch</option>{/* texts-ok */}
          <option value="en" lang="en">English</option>{/* texts-ok */}
        </select>
      </Field>
      <ErrorBox error={error} />
    </section>
  );
}

function Absences() {
  const { settings } = useSession();
  const { data, loading, reload } = useLoad<Absence[]>('/api/me/absences');
  const [deputy, setDeputy] = useState<UserRef | null>(null);
  const [startsOn, setStartsOn] = useState(settings.today);
  const [endsOn, setEndsOn] = useState('');
  const [note, setNote] = useState('');
  const { busy, error, run } = useAction();

  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (await run(() => api.post('/api/me/absences', { deputyId: deputy?.id, startsOn, endsOn, note: note || undefined }))) {
      setDeputy(null);
      setEndsOn('');
      setNote('');
      await reload();
    }
  };
  const remove = async (id: string) => {
    if (await run(() => api.del(`/api/me/absences/${id}`))) await reload();
  };

  return (
    <section className="card" aria-labelledby="h-absence">
      <h2 id="h-absence">{t('account.absence.title')}</h2>
      <p className="small muted">{t('account.absence.intro')}</p>
      <ErrorBox error={error} />
      {loading && !data ? <Loading /> : (
        data && data.length > 0 && (
          <ul className="idea-list">
            {data.map((a) => (
              <li key={a.id} className="row spread">
                <span>
                  {t('account.absence.range', { from: formatDate(a.startsOn), to: formatDate(a.endsOn) })}{' '}
                  {a.mine ? <>{t('account.absence.coveredBy')} <strong>{a.deputyName}</strong></> : <>{t('account.absence.youCover')} <strong>{a.userName}</strong></>}
                  {a.note && <span className="muted"> · {a.note}</span>}
                </span>
                {a.mine && <button type="button" className="link" onClick={() => remove(a.id)} disabled={busy}>{t('account.absence.delete')}</button>}
              </li>
            ))}
          </ul>
        )
      )}
      <form onSubmit={add} style={{ marginTop: 12 }}>
        <Field id="deputy" label={t('account.absence.deputy')}>
          <UserPicker id="deputy" value={deputy} onChange={setDeputy} />
        </Field>
        <div className="grid grid-2" style={{ gap: 12 }}>
          <Field id="from" label={t('account.absence.from')}>
            <input id="from" type="date" value={startsOn} min={settings.today} onChange={(e) => setStartsOn(e.target.value)} required />
          </Field>
          <Field id="to" label={t('account.absence.to')}>
            <input id="to" type="date" value={endsOn} min={startsOn} onChange={(e) => setEndsOn(e.target.value)} required />
          </Field>
        </div>
        <Field id="note" label={t('account.absence.note')}>
          <input id="note" type="text" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} />
        </Field>
        <button disabled={busy || !deputy || !endsOn}>{t('account.absence.add')}</button>
      </form>
    </section>
  );
}

function Preferences() {
  const { data } = useLoad<{ notifyEmail: string; muted: string[] }>('/api/me/preferences');
  const [notifyEmail, setNotifyEmail] = useState('immediate');
  const [muted, setMuted] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const { busy, error, run } = useAction();
  useEffect(() => {
    if (!data) return;
    setNotifyEmail(data.notifyEmail);
    setMuted(data.muted);
  }, [data]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setSaved(false);
    if (await run(() => api.put('/api/me/preferences', { notifyEmail, muted }))) setSaved(true);
  };
  const toggle = (c: string, on: boolean) => setMuted((m) => (on ? m.filter((x) => x !== c) : [...m, c]));

  return (
    <section className="card" aria-labelledby="h-prefs">
      <h2 id="h-prefs">{t('account.prefs.title')}</h2>
      <form onSubmit={save}>
        <ErrorBox error={error} />
        {saved && <div className="alert success" role="status">{t('account.prefs.saved')}</div>}
        <fieldset>
          <legend>{t('account.prefs.emails')}</legend>
          {[
            ['immediate', t('account.prefs.immediate')],
            ['daily', t('account.prefs.daily')],
            ['off', t('account.prefs.off')],
          ].map(([v, l]) => (
            <label key={v} className="check">
              <input type="radio" name="notify" checked={notifyEmail === v} onChange={() => setNotifyEmail(v)} /> {l}
            </label>
          ))}
        </fieldset>
        <fieldset>
          <legend>{t('account.prefs.topics')}</legend>
          {Object.entries(CATEGORY_LABEL).map(([c, l]) => (
            <label key={c} className="check">
              <input type="checkbox" checked={!muted.includes(c)} onChange={(e) => toggle(c, e.target.checked)} disabled={notifyEmail === 'off' && c !== 'trends'} /> {l}
            </label>
          ))}
          <p className="hint">{t('account.prefs.bellHint')}</p>
        </fieldset>
        <button className="primary" disabled={busy}>{t('account.prefs.save')}</button>
      </form>
    </section>
  );
}

// Recognition (R2-38): naming on the success page can be switched off; badge and certificates.
function Recognition() {
  const { data, setData } = useLoad<{ showOnSuccessPage: boolean; implementedIdeas: number; stories: { id: string; title: string }[] }>('/api/me/recognition');
  const { busy, error, run } = useAction();
  const [saved, setSaved] = useState(false);
  if (!data) return null;
  const toggle = async (show: boolean) => {
    setSaved(false);
    const r = await run(() => api.put<typeof data>('/api/me/recognition', { showOnSuccessPage: show }));
    if (r) {
      setData(r);
      setSaved(true);
    }
  };
  return (
    <section className="card" aria-labelledby="h-recognition">
      <h2 id="h-recognition">{t('account.recognition.title')}</h2>
      <ErrorBox error={error} />
      {data.implementedIdeas > 0 ? (
        <p>
          <span className="badge green" aria-hidden="true">★</span> {t('account.recognition.before')} <strong>{data.implementedIdeas}</strong> {tn('account.recognition.after', data.implementedIdeas)}
        </p>
      ) : (
        <p className="muted">{t('account.recognition.none')}</p>
      )}
      <label className="check">
        <input type="checkbox" checked={data.showOnSuccessPage} disabled={busy} onChange={(e) => toggle(e.target.checked)} /> {t('account.recognition.showBefore')} <Link to="/erfolge">{t('account.recognition.successPage')}</Link> {t('account.recognition.showAfter')}
      </label>
      {saved && <p className="small" role="status">{t('account.recognition.saved')}</p>}
      {data.stories.length > 0 && (
        <>
          <h3>{t('account.recognition.certificates')}</h3>
          <ul>
            {data.stories.map((s) => <li key={s.id}><Link to={`/erfolge/${s.id}/urkunde`}>{s.title}</Link></li>)}
          </ul>
        </>
      )}
    </section>
  );
}
