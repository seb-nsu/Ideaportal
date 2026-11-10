import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { ErrorBox, Field, Loading, useAction, useLoad } from '../components';
import { formatDateTime, labelMap, t } from '../i18n';

// Settings › Integrations › Connectors (R3-13 Jira, R3-14 ServiceNow, R3-15 Azure DevOps):
// target, credentials, field and status mapping, activation per click, callback secret.

const KINDS = ['jira', 'servicenow', 'azure_devops'] as const;
type Kind = (typeof KINDS)[number];
const SOURCES = ['number', 'url', 'topic', 'targetDate', 'benefit', 'effortPersonDays', 'effortEuro', 'planBenefitEuro', 'channel'] as const;
const ITEM_TYPES: Record<Kind, string[]> = {
  jira: ['Epic', 'Story', 'Task'],
  servicenow: ['dmn_demand', 'pm_project'],
  azure_devops: ['Epic', 'Feature', 'User Story'],
};
const STORY_DEFAULT: Record<Kind, string> = { jira: 'Story', servicenow: 'rm_story', azure_devops: 'User Story' };

interface Config {
  project: string;
  itemType: string;
  storyType: string;
  parentField: string;
  fieldMap: { source: string; target: string }[];
  statusMap: { external: string; progress: number }[];
  poll: boolean;
}

interface Connector {
  id: string;
  kind: Kind;
  name: string;
  baseUrl: string;
  config: Config;
  enabled: boolean;
  hasCredentials: boolean;
  callbackUrl: string;
  lastPollAt: string | null;
  lastError: string | null;
  links: number;
}

interface Form {
  kind: Kind;
  name: string;
  baseUrl: string;
  config: Partial<Config>;
  credentials: Record<string, string>;
}

const emptyForm = (kind: Kind = 'jira'): Form => ({ kind, name: '', baseUrl: 'https://', config: { itemType: ITEM_TYPES[kind][0], storyType: STORY_DEFAULT[kind], fieldMap: [], poll: false }, credentials: {} });

export function Connectors() {
  const KIND_LABELS = labelMap('connectors.kind', KINDS);
  const { data, error, loading, reload } = useLoad<Connector[]>('/api/admin/connectors');
  const { busy, error: actionError, run } = useAction();
  const [form, setForm] = useState<Form | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!form) return;
    setNotice(null);
    const credentials = Object.fromEntries(Object.entries(form.credentials).filter(([, v]) => v));
    const body = { name: form.name, baseUrl: form.baseUrl, config: form.config, ...(Object.keys(credentials).length ? { credentials } : {}) };
    if (editId) {
      if (await run(() => api.patch(`/api/admin/connectors/${editId}`, body))) {
        setForm(null);
        setEditId(null);
        reload();
      }
      return;
    }
    const r = await run(() => api.post<{ callbackSecret: string }>('/api/admin/connectors', { kind: form.kind, ...body }));
    if (r) {
      setSecret(r.callbackSecret);
      setForm(null);
      reload();
    }
  };
  const act = async (c: Connector, path: string, confirmText?: string) => {
    if (confirmText && !window.confirm(confirmText)) return;
    setNotice(null);
    const r = await run(() => api.post<Record<string, unknown>>(`/api/admin/connectors/${c.id}/${path}`));
    if (!r) return;
    if (path === 'test') setNotice(r.ok ? t('connectors.testOk') : t('connectors.testFailed', { reason: String(r.reason) }));
    if (path === 'poll') setNotice(t('connectors.pollResult', { checked: Number(r.checked), updated: Number(r.updated), errors: Number(r.errors) }));
    if (path === 'rotate-secret') setSecret(String(r.callbackSecret));
    reload();
  };
  const remove = async (c: Connector) => {
    if (!window.confirm(t('connectors.deleteConfirm', { name: c.name }))) return;
    if (await run(() => api.del(`/api/admin/connectors/${c.id}`))) reload();
  };
  const edit = (c: Connector) => {
    setEditId(c.id);
    setForm({ kind: c.kind, name: c.name, baseUrl: c.baseUrl, config: c.config, credentials: {} });
  };

  return (
    <section className="card stack" aria-labelledby="h-connectors">
      <h2 id="h-connectors">{t('connectors.title')}</h2>
      <p>{t('connectors.intro')}</p>
      <p className="small muted">{t('connectors.guide')}</p>
      <ErrorBox error={actionError} />
      {secret && <Secret value={secret} />}
      {notice && <div className="alert" role="status">{notice}</div>}
      <ErrorBox error={error} />
      {loading && !data && <Loading />}
      {data?.length === 0 && <p className="muted">{t('connectors.empty')}</p>}
      {data?.map((c) => (
        <article key={c.id} className="stack" style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
          <div className="row">
            <strong>{c.name}</strong>
            <span className="small muted">{KIND_LABELS[c.kind]} · {c.baseUrl}</span>
            <span className={`badge ${c.enabled ? 'green' : 'red'}`}>{c.enabled ? t('connectors.state.on') : t('connectors.state.off')}</span>
          </div>
          <p className="small muted">
            {t('connectors.links', { n: c.links })}
            {!c.hasCredentials && ` · ${t('connectors.noCredentials')}`}
            {c.lastPollAt && ` · ${t('connectors.lastPoll', { date: formatDateTime(c.lastPollAt) })}`}
            {c.lastError && ` · ${t('connectors.lastError', { error: c.lastError })}`}
          </p>
          <p className="small">{t('connectors.callbackUrl')}: <code>{c.callbackUrl}</code></p>
          <div className="row">
            {c.enabled
              ? <button disabled={busy} onClick={() => act(c, 'disable')}>{t('connectors.disable')}</button>
              : <button className="primary" disabled={busy || !c.hasCredentials} onClick={() => act(c, 'enable')}>{t('connectors.enable')}</button>}
            <button disabled={busy || !c.hasCredentials} onClick={() => act(c, 'test')}>{t('connectors.test')}</button>
            {c.enabled && <button disabled={busy} onClick={() => act(c, 'poll')}>{t('connectors.pollNow')}</button>}
            <button disabled={busy} onClick={() => edit(c)}>{t('connectors.edit')}</button>
            <button disabled={busy} onClick={() => act(c, 'rotate-secret', t('connectors.rotateConfirm'))}>{t('connectors.rotate')}</button>
            <button className="link" disabled={busy} onClick={() => remove(c)}>{t('connectors.delete')}</button>
          </div>
        </article>
      ))}
      {!form && <div><button onClick={() => { setEditId(null); setSecret(null); setForm(emptyForm()); }}>{t('connectors.new')}</button></div>}
      {form && <ConnectorForm form={form} setForm={setForm} editing={!!editId} busy={busy} onSubmit={submit} onCancel={() => { setForm(null); setEditId(null); }} />}
    </section>
  );
}

function Secret({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="alert success" role="status">
      <p>{t('connectors.secretCreated')}</p>
      <div className="row">
        <input type="text" readOnly value={value} aria-label={t('connectors.secretCreated')} onFocus={(e) => e.target.select()} style={{ flex: 1, minWidth: 220 }} />
        <button type="button" onClick={copy}>{copied ? t('connectors.copied') : t('connectors.copy')}</button>
      </div>
    </div>
  );
}

function ConnectorForm({ form, setForm, editing, busy, onSubmit, onCancel }: {
  form: Form; setForm: (f: Form) => void; editing: boolean; busy: boolean; onSubmit: (e: FormEvent) => void; onCancel: () => void;
}) {
  const KIND_LABELS = labelMap('connectors.kind', KINDS);
  const SOURCE_LABELS = labelMap('connectors.source', SOURCES);
  const k = form.kind;
  const cfg = form.config;
  const setCfg = (patch: Partial<Config>) => setForm({ ...form, config: { ...cfg, ...patch } });
  const setCred = (key: string, value: string) => setForm({ ...form, credentials: { ...form.credentials, [key]: value } });
  const fieldMap = cfg.fieldMap ?? [];
  const statusMap = cfg.statusMap;
  const credentialFields: [string, string, string][] = k === 'jira'
    ? [['email', t('connectors.email'), 'email'], ['apiToken', t('connectors.apiToken'), 'password']]
    : k === 'servicenow'
      ? [['username', t('connectors.username'), 'text'], ['password', t('connectors.password'), 'password']]
      : [['pat', t('connectors.pat'), 'password']];

  return (
    <form className="stack" onSubmit={onSubmit}>
      <div className="grid grid-3">
        <Field id="cn-kind" label={t('connectors.kindLabel')}>
          <select id="cn-kind" value={k} disabled={editing} onChange={(e) => setForm(emptyForm(e.target.value as Kind))}>
            {KINDS.map((x) => <option key={x} value={x}>{KIND_LABELS[x]}</option>)}
          </select>
        </Field>
        <Field id="cn-name" label={t('connectors.name')}>
          <input id="cn-name" type="text" value={form.name} required minLength={2} maxLength={80} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <Field id="cn-url" label={t('connectors.baseUrl')} hint={t(`connectors.baseUrlHint.${k}`)}>
          <input id="cn-url" type="url" value={form.baseUrl} required pattern="https://.*" aria-describedby="cn-url-hint" onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} />
        </Field>
        {k !== 'servicenow' && (
          <Field id="cn-project" label={t(`connectors.project.${k}`)}>
            <input id="cn-project" type="text" value={cfg.project ?? ''} required maxLength={100} onChange={(e) => setCfg({ project: e.target.value })} />
          </Field>
        )}
        <Field id="cn-type" label={t(`connectors.itemType.${k}`)}>
          <select id="cn-type" value={cfg.itemType ?? ITEM_TYPES[k][0]} onChange={(e) => setCfg({ itemType: e.target.value })}>
            {ITEM_TYPES[k].map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
        </Field>
        <Field id="cn-story" label={t('connectors.storyType')} hint={t('connectors.storyTypeHint')}>
          <input id="cn-story" type="text" value={cfg.storyType ?? STORY_DEFAULT[k]} maxLength={60} aria-describedby="cn-story-hint" onChange={(e) => setCfg({ storyType: e.target.value })} />
        </Field>
      </div>
      <fieldset>
        <legend>{t('connectors.credentials')}</legend>
        <p className="small muted">{t('connectors.credentialsHint')}</p>
        <div className="grid grid-3">
          {credentialFields.map(([key, label, type]) => (
            <Field key={key} id={`cn-cred-${key}`} label={label}>
              <input id={`cn-cred-${key}`} type={type} autoComplete="off" value={form.credentials[key] ?? ''} onChange={(e) => setCred(key, e.target.value)} />
            </Field>
          ))}
        </div>
      </fieldset>
      <fieldset className="stack">
        <legend>{t('connectors.fieldMap')}</legend>
        <p className="small muted">{t('connectors.fieldMapHint')}</p>
        {fieldMap.map((f, i) => (
          <div key={i} className="row">
            <select aria-label={t('connectors.fieldSource')} value={f.source} onChange={(e) => setCfg({ fieldMap: fieldMap.map((x, j) => (j === i ? { ...x, source: e.target.value } : x)) })}>
              {SOURCES.map((s) => <option key={s} value={s}>{SOURCE_LABELS[s]}</option>)}
            </select>
            <input type="text" aria-label={t('connectors.fieldTarget')} value={f.target} required pattern="[A-Za-z0-9_.]+" onChange={(e) => setCfg({ fieldMap: fieldMap.map((x, j) => (j === i ? { ...x, target: e.target.value } : x)) })} />
            <button type="button" className="link" onClick={() => setCfg({ fieldMap: fieldMap.filter((_, j) => j !== i) })}>{t('connectors.remove')}</button>
          </div>
        ))}
        <div><button type="button" onClick={() => setCfg({ fieldMap: [...fieldMap, { source: 'number', target: '' }] })}>{t('connectors.addField')}</button></div>
      </fieldset>
      {statusMap && (
        <fieldset className="stack">
          <legend>{t('connectors.statusMap')}</legend>
          <p className="small muted">{t('connectors.statusMapHint')}</p>
          {statusMap.map((s, i) => (
            <div key={i} className="row">
              <input type="text" aria-label={t('connectors.statusExternal')} value={s.external} required maxLength={80} onChange={(e) => setCfg({ statusMap: statusMap.map((x, j) => (j === i ? { ...x, external: e.target.value } : x)) })} />
              <input type="number" aria-label={t('connectors.statusProgress')} min={0} max={100} value={s.progress} onChange={(e) => setCfg({ statusMap: statusMap.map((x, j) => (j === i ? { ...x, progress: Number(e.target.value) } : x)) })} style={{ width: 90 }} />
              <button type="button" className="link" onClick={() => setCfg({ statusMap: statusMap.filter((_, j) => j !== i) })}>{t('connectors.remove')}</button>
            </div>
          ))}
          <div><button type="button" onClick={() => setCfg({ statusMap: [...statusMap, { external: '', progress: 50 }] })}>{t('connectors.addStatus')}</button></div>
        </fieldset>
      )}
      <label className="check">
        <input type="checkbox" checked={!!cfg.poll} onChange={(e) => setCfg({ poll: e.target.checked })} /> {t('connectors.poll')}
      </label>
      <div className="row">
        <button type="button" onClick={onCancel}>{t('connectors.cancel')}</button>
        <button className="primary" disabled={busy}>{editing ? t('connectors.save') : t('connectors.create')}</button>
      </div>
    </form>
  );
}
