import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../api';
import { ErrorBox, Field, Loading, useAction, useLoad } from '../components';
import { formatDate, labelMap, t } from '../i18n';

// Slack and Microsoft Teams as an additional notification channel (R3-16): the opt-in of
// each person (same categories as e-mail, R1-36) and the workspace configuration for admins.

const CATEGORIES = ['my_ideas', 'community', 'tasks', 'reminders', 'trends'] as const;
const CATEGORY_LABEL = labelMap('account.category', CATEGORIES);

interface MyChat {
  available: { slack: boolean; slackBot: boolean; teams: boolean };
  channel: 'off' | 'slack' | 'teams';
  muted: string[];
  webhookSet: boolean;
  slackLinked: boolean;
  teamsLinked: boolean;
}

export function ChatPreferences() {
  const { data, setData } = useLoad<MyChat>('/api/me/chat');
  const [channel, setChannel] = useState<MyChat['channel']>('off');
  const [muted, setMuted] = useState<string[]>([]);
  const [webhook, setWebhook] = useState('');
  const [removeWebhook, setRemoveWebhook] = useState(false);
  const [saved, setSaved] = useState(false);
  const [code, setCode] = useState<{ code: string; expiresAt: string } | null>(null);
  const { busy, error, run } = useAction();

  useEffect(() => {
    if (!data) return;
    setChannel(data.channel);
    setMuted(data.muted);
  }, [data]);

  if (!data) return null;
  const { available } = data;
  if (!available.slack && !available.teams) {
    return (
      <section className="card" aria-labelledby="h-chat">
        <h2 id="h-chat">{t('chat.prefs.title')}</h2>
        <p className="muted">{t('chat.prefs.none')}</p>
      </section>
    );
  }

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setSaved(false);
    const webhookUrl = removeWebhook ? null : webhook.trim() ? webhook.trim() : undefined;
    const r = await run(() => api.put<MyChat>('/api/me/chat', { channel, muted, ...(webhookUrl === undefined ? {} : { webhookUrl }) }));
    if (r) {
      setData(r);
      setWebhook('');
      setRemoveWebhook(false);
      setSaved(true);
    }
  };
  const toggle = (c: string, on: boolean) => setMuted((m) => (on ? m.filter((x) => x !== c) : [...m, c]));
  const createCode = async () => {
    const r = await run(() => api.post<{ code: string; expiresAt: string }>('/api/me/chat/link-code'));
    if (r) setCode(r);
  };
  const needsWebhook = channel === 'teams' || (channel === 'slack' && !available.slackBot);
  const options: [MyChat['channel'], string][] = [
    ['off', t('chat.prefs.off')],
    ...(available.slack ? [['slack', t('chat.prefs.slack')] as [MyChat['channel'], string]] : []),
    ...(available.teams ? [['teams', t('chat.prefs.teams')] as [MyChat['channel'], string]] : []),
  ];

  return (
    <section className="card" aria-labelledby="h-chat">
      <h2 id="h-chat">{t('chat.prefs.title')}</h2>
      <p className="hint">{t('chat.prefs.intro')}</p>
      <form onSubmit={save}>
        <ErrorBox error={error} />
        {saved && <div className="alert success" role="status">{t('chat.prefs.saved')}</div>}
        <fieldset>
          <legend>{t('chat.prefs.channel')}</legend>
          {options.map(([v, l]) => (
            <label key={v} className="check">
              <input type="radio" name="chat-channel" checked={channel === v} onChange={() => setChannel(v)} /> {l}
            </label>
          ))}
        </fieldset>
        {channel === 'slack' && available.slackBot && <p className="hint">{t('chat.prefs.slackBot')}</p>}
        {channel !== 'off' && (needsWebhook || data.webhookSet) && (
          <Field id="chat-webhook" label={t('chat.prefs.webhook')} hint={channel === 'teams' ? t('chat.prefs.webhookHintTeams') : t('chat.prefs.webhookHintSlack')}>
            <input id="chat-webhook" type="url" inputMode="url" autoComplete="off" value={webhook} onChange={(e) => setWebhook(e.target.value)} aria-describedby="chat-webhook-hint" />
          </Field>
        )}
        {data.webhookSet && (
          <>
            <p className="hint">{t('chat.prefs.webhookSet')}</p>
            <label className="check">
              <input type="checkbox" checked={removeWebhook} onChange={(e) => setRemoveWebhook(e.target.checked)} /> {t('chat.prefs.removeWebhook')}
            </label>
          </>
        )}
        <fieldset>
          <legend>{t('chat.prefs.topics')}</legend>
          {CATEGORIES.map((c) => (
            <label key={c} className="check">
              <input type="checkbox" checked={!muted.includes(c)} onChange={(e) => toggle(c, e.target.checked)} disabled={channel === 'off'} /> {CATEGORY_LABEL[c]}
            </label>
          ))}
        </fieldset>
        <button className="primary" disabled={busy}>{t('chat.prefs.save')}</button>
      </form>
      {available.teams && (
        <div className="stack" style={{ marginTop: '1rem' }}>
          <h3>{t('chat.prefs.linkTitle')}</h3>
          {data.teamsLinked ? <p>{t('chat.prefs.linked')}</p> : <p className="hint">{t('chat.prefs.linkIntro')}</p>}
          {code && <p role="status"><strong>{t('chat.prefs.linkCode', { code: code.code, time: `${formatDate(code.expiresAt)} ${new Date(code.expiresAt).toLocaleTimeString().slice(0, 5)}` })}</strong></p>}
          <div>
            <button type="button" onClick={createCode} disabled={busy}>{t('chat.prefs.linkButton')}</button>
          </div>
        </div>
      )}
    </section>
  );
}

interface ChatAdminView {
  slack: { enabled: boolean; teamId: string | null; signingSecretSet: boolean; botTokenSet: boolean; commandsUrl: string | null; interactionsUrl: string | null };
  teams: { enabled: boolean; botAppId: string | null; secretSet: boolean; messagesUrl: string | null };
}

export function ChatAdmin() {
  const { data, error: loadError, setData } = useLoad<ChatAdminView>('/api/admin/chat');
  if (loadError) return <ErrorBox error={loadError} />;
  if (!data) return <Loading />;
  return (
    <div className="stack">
      <p className="hint">{t('chat.admin.intro')}</p>
      <SlackForm view={data} onSaved={setData} />
      <TeamsForm view={data} onSaved={setData} />
      <p className="hint">{t('chat.admin.guide')}</p>
    </div>
  );
}

function Url({ label, value }: { label: string; value: string | null }) {
  return (
    <p>
      {label}: {value ? <code>{value}</code> : <span className="muted">{t('chat.admin.saveFirst')}</span>}
    </p>
  );
}

function SlackForm({ view, onSaved }: { view: ChatAdminView; onSaved: (v: ChatAdminView) => void }) {
  const [enabled, setEnabled] = useState(view.slack.enabled);
  const [teamId, setTeamId] = useState(view.slack.teamId ?? '');
  const [secret, setSecret] = useState('');
  const [token, setToken] = useState('');
  const [saved, setSaved] = useState(false);
  const { busy, error, run } = useAction();
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setSaved(false);
    const r = await run(() => api.put<ChatAdminView>('/api/admin/chat/slack', {
      enabled, externalId: teamId.trim() || null, ...(secret ? { signingSecret: secret } : {}), ...(token ? { botToken: token } : {}),
    }));
    if (r) {
      onSaved(r);
      setSecret('');
      setToken('');
      setSaved(true);
    }
  };
  return (
    <section className="card" aria-labelledby="h-chat-slack">
      <h2 id="h-chat-slack">{t('chat.admin.slack')}</h2>
      <form onSubmit={save}>
        <ErrorBox error={error} />
        {saved && <div className="alert success" role="status">{t('chat.admin.saved')}</div>}
        <label className="check">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> {t('chat.admin.enabled')}
        </label>
        <Field id="slack-team" label={t('chat.admin.teamId')}>
          <input id="slack-team" value={teamId} onChange={(e) => setTeamId(e.target.value)} autoComplete="off" />
        </Field>
        <Field id="slack-secret" label={t('chat.admin.signingSecret')} hint={view.slack.signingSecretSet ? t('chat.admin.secretSet') : t('chat.admin.secretMissing')}>
          <input id="slack-secret" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="off" aria-describedby="slack-secret-hint" />
        </Field>
        <Field id="slack-token" label={t('chat.admin.botToken')} hint={view.slack.botTokenSet ? t('chat.admin.secretSet') : t('chat.admin.secretMissing')}>
          <input id="slack-token" type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" aria-describedby="slack-token-hint" />
        </Field>
        <Url label={t('chat.admin.commandsUrl')} value={view.slack.commandsUrl} />
        <Url label={t('chat.admin.interactionsUrl')} value={view.slack.interactionsUrl} />
        <button className="primary" disabled={busy}>{t('chat.admin.save')}</button>
      </form>
    </section>
  );
}

function TeamsForm({ view, onSaved }: { view: ChatAdminView; onSaved: (v: ChatAdminView) => void }) {
  const [enabled, setEnabled] = useState(view.teams.enabled);
  const [appId, setAppId] = useState(view.teams.botAppId ?? '');
  const [secret, setSecret] = useState('');
  const [saved, setSaved] = useState(false);
  const { busy, error, run } = useAction();
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setSaved(false);
    const r = await run(() => api.put<ChatAdminView>('/api/admin/chat/teams', { enabled, externalId: appId.trim() || null, ...(secret ? { signingSecret: secret } : {}) }));
    if (r) {
      onSaved(r);
      setSecret('');
      setSaved(true);
    }
  };
  return (
    <section className="card" aria-labelledby="h-chat-teams">
      <h2 id="h-chat-teams">{t('chat.admin.teams')}</h2>
      <form onSubmit={save}>
        <ErrorBox error={error} />
        {saved && <div className="alert success" role="status">{t('chat.admin.saved')}</div>}
        <label className="check">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> {t('chat.admin.enabled')}
        </label>
        <Field id="teams-secret" label={t('chat.admin.teamsSecret')} hint={view.teams.secretSet ? t('chat.admin.secretSet') : t('chat.admin.secretMissing')}>
          <input id="teams-secret" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="off" aria-describedby="teams-secret-hint" />
        </Field>
        <Field id="teams-app" label={t('chat.admin.botAppId')}>
          <input id="teams-app" value={appId} onChange={(e) => setAppId(e.target.value)} autoComplete="off" />
        </Field>
        <Url label={t('chat.admin.messagesUrl')} value={view.teams.messagesUrl} />
        <button className="primary" disabled={busy}>{t('chat.admin.save')}</button>
      </form>
    </section>
  );
}
