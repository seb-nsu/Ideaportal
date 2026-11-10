import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ApiError, api } from '../../api';
import { ErrorBox, Field, Loading, useAction } from '../../components';
import { formatDateTime, labelMap, t } from '../../i18n';

// Handover of an approved idea to Jira, ServiceNow or Azure DevOps (R3-13 to R3-15) and the
// implementation package (R3-18), shown below the implementation card.

interface HandoverView {
  canManage: boolean;
  allowed: boolean;
  confidential: boolean;
  hasPackage: boolean;
  connectors: { id: string; name: string; kind: string }[];
  links: {
    id: string;
    role: 'main' | 'story';
    storyIndex: number;
    externalKey: string | null;
    externalUrl: string | null;
    externalStatus: string | null;
    mappedProgress: number | null;
    connectorName: string;
    kind: string;
  }[];
}

const BRIEF_FIELDS = ['goal', 'scope', 'outOfScope', 'benefit', 'effort', 'risks', 'milestones', 'openQuestions'] as const;
type Brief = Record<(typeof BRIEF_FIELDS)[number], string>;
interface Story {
  title: string;
  description: string;
  acceptance: string[];
}
interface Package {
  brief: Brief;
  stories: Story[];
  source: 'ai' | 'human';
  version: number;
  updatedAt: string;
  updatedBy: string | null;
}

export function Handover({ ideaId, onChanged }: { ideaId: string; onChanged: () => void }) {
  const [view, setView] = useState<HandoverView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setView(await api.get<HandoverView>(`/api/ideas/${ideaId}/handover`));
    } catch (err) {
      setLoadError((err as Error).message);
    }
  }, [ideaId]);
  useEffect(() => {
    void load();
  }, [load]);

  if (loadError) return <ErrorBox error={loadError} />;
  if (!view) return null;
  if (!view.canManage && view.links.length === 0) return null;
  const reload = () => {
    void load();
    onChanged();
  };
  return (
    <>
      {view.canManage && view.allowed && <PackageCard ideaId={ideaId} onChanged={reload} />}
      <section className="card stack" aria-labelledby="h-handover">
        <h2 id="h-handover">{t('connectors.handover.title')}</h2>
        {view.links.length > 0 && <Links links={view.links} />}
        {view.canManage && !view.allowed && <p className="muted small">{t('connectors.handover.notAllowed')}</p>}
        {view.canManage && view.allowed && view.connectors.length === 0 && <p className="muted small">{t('connectors.handover.none')}</p>}
        {view.canManage && view.allowed && view.connectors.length > 0 && <HandoverForm ideaId={ideaId} view={view} onDone={reload} />}
      </section>
    </>
  );
}

function Links({ links }: { links: HandoverView['links'] }) {
  return (
    <div>
      <h3>{t('connectors.handover.links')}</h3>
      <ul className="small">
        {links.map((l) => (
          <li key={l.id}>
            {l.connectorName} · {l.role === 'main' ? t('connectors.handover.main') : t('connectors.handover.story', { n: l.storyIndex + 1 })}:{' '}
            {l.externalUrl ? <a href={l.externalUrl} target="_blank" rel="noopener noreferrer">{l.externalKey ?? t('connectors.handover.open')}</a> : l.externalKey}
            {' · '}
            {l.externalStatus ? t('connectors.handover.status', { status: l.externalStatus }) : t('connectors.handover.noStatus')}
            {l.mappedProgress != null && ` (${l.mappedProgress} %)`}
          </li>
        ))}
      </ul>
    </div>
  );
}

function HandoverForm({ ideaId, view, onDone }: { ideaId: string; view: HandoverView; onDone: () => void }) {
  const KINDS = labelMap('connectors.kind', ['jira', 'servicenow', 'azure_devops'] as const);
  const { busy, error, run } = useAction();
  const [connectorId, setConnectorId] = useState(view.connectors[0]?.id ?? '');
  const [withPackage, setWithPackage] = useState(view.hasPackage);
  const [confirm, setConfirm] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setResult(null);
    const r = await run(() => api.post<{ main: { key: string | null; id: string }; stories: number; failed: unknown[] }>(`/api/ideas/${ideaId}/handover`, {
      connectorId, withPackage: withPackage && view.hasPackage, confirmConfidential: confirm,
    }));
    if (r) {
      const parts = [t('connectors.handover.done', { ref: r.main.key ?? r.main.id })];
      if (r.stories) parts.push(t('connectors.handover.stories', { n: r.stories }));
      if (r.failed.length) parts.push(t('connectors.handover.failed', { n: r.failed.length }));
      setResult(parts.join(' '));
      onDone();
    }
  };

  return (
    <form className="stack" onSubmit={submit}>
      <ErrorBox error={error} />
      {result && <div className="alert success" role="status">{result}</div>}
      <Field id="handover-target" label={t('connectors.handover.target')}>
        <select id="handover-target" value={connectorId} onChange={(e) => setConnectorId(e.target.value)}>
          {view.connectors.map((c) => <option key={c.id} value={c.id}>{c.name} ({KINDS[c.kind] ?? c.kind})</option>)}
        </select>
      </Field>
      {view.hasPackage && (
        <label className="check">
          <input type="checkbox" checked={withPackage} onChange={(e) => setWithPackage(e.target.checked)} /> {t('connectors.handover.withPackage')}
        </label>
      )}
      {view.confidential && (
        <label className="check">
          <input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} required /> {t('connectors.handover.confidential')}
        </label>
      )}
      <div><button className="primary" disabled={busy || !connectorId || (view.confidential && !confirm)}>{t('connectors.handover.submit')}</button></div>
    </form>
  );
}

function PackageCard({ ideaId, onChanged }: { ideaId: string; onChanged: () => void }) {
  const H = labelMap('connectors.pkg.h', BRIEF_FIELDS);
  const [pkg, setPkg] = useState<Package | null | undefined>(undefined);
  const [editing, setEditing] = useState<Package | null>(null);
  const { busy, error, run } = useAction();

  const load = useCallback(async () => {
    try {
      setPkg(await api.get<Package>(`/api/ideas/${ideaId}/package`));
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) setPkg(null);
      else throw err;
    }
  }, [ideaId]);
  useEffect(() => {
    void load();
  }, [load]);

  const generate = async () => {
    const replaceEdited = pkg?.source === 'human';
    if (replaceEdited && !window.confirm(t('connectors.pkg.replaceConfirm'))) return;
    const r = await run(() => api.post<Package>(`/api/ideas/${ideaId}/package/generate`, { replaceEdited }));
    if (r) {
      setPkg(r);
      onChanged();
    }
  };
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    const stories = editing.stories.map((s) => ({ ...s, acceptance: s.acceptance.map((a) => a.trim()).filter(Boolean) }));
    const r = await run(() => api.put<Package>(`/api/ideas/${ideaId}/package`, { brief: editing.brief, stories, version: editing.version }));
    if (r) {
      setPkg(r);
      setEditing(null);
    }
  };
  const setStory = (i: number, patch: Partial<Story>) => editing && setEditing({ ...editing, stories: editing.stories.map((s, j) => (j === i ? { ...s, ...patch } : s)) });

  return (
    <section className="card stack" aria-labelledby="h-package">
      <h2 id="h-package">{t('connectors.pkg.title')}</h2>
      <p className="small muted">{t('connectors.pkg.intro')}</p>
      <ErrorBox error={error} />
      {pkg === undefined && <Loading />}
      {pkg === null && <div><button className="primary" disabled={busy} onClick={generate}>{t('connectors.pkg.generate')}</button></div>}
      {pkg && !editing && (
        <>
          <p className="small">
            {pkg.source === 'ai'
              ? <span className="badge yellow">{t('connectors.pkg.aiBadge')}</span>
              : t('connectors.pkg.edited', { name: pkg.updatedBy ?? '–', date: formatDateTime(pkg.updatedAt) })}
          </p>
          <h3>{t('connectors.pkg.brief')}</h3>
          <dl>
            {BRIEF_FIELDS.map((f) => (
              <div key={f}>
                <dt><strong>{H[f]}</strong></dt>
                <dd className="pre">{pkg.brief[f] || '–'}</dd>
              </div>
            ))}
          </dl>
          <h3>{t('connectors.pkg.stories')}</h3>
          <ol>
            {pkg.stories.map((s, i) => (
              <li key={i}>
                <strong>{s.title}</strong>
                <p className="pre small">{s.description}</p>
                {s.acceptance.length > 0 && <ul className="small">{s.acceptance.map((a, j) => <li key={j}>{a}</li>)}</ul>}
              </li>
            ))}
          </ol>
          <div className="row">
            <button onClick={() => setEditing(pkg)}>{t('connectors.pkg.edit')}</button>
            <button disabled={busy} onClick={generate}>{t('connectors.pkg.regenerate')}</button>
            <a className="button" href={`/api/ideas/${ideaId}/package/export?format=md`} download>{t('connectors.pkg.exportMd')}</a>
            <a className="button" href={`/api/ideas/${ideaId}/package/export?format=pdf`} download>{t('connectors.pkg.exportPdf')}</a>
          </div>
        </>
      )}
      {editing && (
        <form className="stack" onSubmit={save}>
          <h3>{t('connectors.pkg.brief')}</h3>
          {BRIEF_FIELDS.map((f) => (
            <Field key={f} id={`pkg-${f}`} label={H[f]}>
              <textarea id={`pkg-${f}`} value={editing.brief[f]} maxLength={4000} onChange={(e) => setEditing({ ...editing, brief: { ...editing.brief, [f]: e.target.value } })} />
            </Field>
          ))}
          <h3>{t('connectors.pkg.stories')}</h3>
          {editing.stories.map((s, i) => (
            <fieldset key={i} className="stack">
              <legend>{t('connectors.pkg.storyN', { n: i + 1 })}</legend>
              <Field id={`story-${i}-title`} label={t('connectors.pkg.storyTitle')}>
                <input id={`story-${i}-title`} type="text" value={s.title} maxLength={200} required onChange={(e) => setStory(i, { title: e.target.value })} />
              </Field>
              <Field id={`story-${i}-desc`} label={t('connectors.pkg.storyDescription')}>
                <textarea id={`story-${i}-desc`} value={s.description} maxLength={3000} onChange={(e) => setStory(i, { description: e.target.value })} />
              </Field>
              <Field id={`story-${i}-acc`} label={t('connectors.pkg.storyAcceptance')}>
                <textarea id={`story-${i}-acc`} value={s.acceptance.join('\n')} onChange={(e) => setStory(i, { acceptance: e.target.value.split('\n') })} />
              </Field>
              {editing.stories.length > 1 && (
                <div><button type="button" className="link" onClick={() => setEditing({ ...editing, stories: editing.stories.filter((_, j) => j !== i) })}>{t('connectors.pkg.removeStory')}</button></div>
              )}
            </fieldset>
          ))}
          {editing.stories.length < 15 && (
            <div><button type="button" onClick={() => setEditing({ ...editing, stories: [...editing.stories, { title: '', description: '', acceptance: [] }] })}>{t('connectors.pkg.addStory')}</button></div>
          )}
          <div className="row">
            <button type="button" onClick={() => setEditing(null)}>{t('connectors.pkg.cancel')}</button>
            <button className="primary" disabled={busy}>{t('connectors.pkg.save')}</button>
          </div>
        </form>
      )}
    </section>
  );
}
