import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { Dialog, ErrorBox, Field, Loading, useAction, useLoad } from '../components';
import { intlLocale, labelMap, t } from '../i18n';
import { KIND_LABEL, SampleForm } from './AiPanel';
import { QualityDashboard } from './QualityDashboard';
import { EvalReports, EvalSettings } from './EvalReports';

// Settings › KI (R2-09, R2-10, R2-12): providers, a model per task, prices and budgets,
// web search, quality check and the AI log. Keys are write-only.

type Slot = 'fast' | 'deep' | 'vision' | 'speech' | 'confidential';
interface Provider { id: string; name: string; kind: 'builtin' | 'anthropic' | 'openai_compatible'; baseUrl: string; hosting: 'local' | 'eu' | 'other'; keySource: 'none' | 'tenant' | 'platform' }
interface ModelRef { provider: string; model: string }
interface AiSettings {
  enabled: boolean;
  providers: Provider[];
  models: Record<Slot, ModelRef>;
  agents: Record<string, { enabled: boolean; model?: ModelRef; minScore?: number }>;
  prices: { model: string; inputPerMTok: number; outputPerMTok: number }[];
  fallbackPrice: { inputPerMTok: number; outputPerMTok: number };
  budget: { perIdeaEur: number; perMonthEur: number };
  search: { kind: 'none' | 'brave' | 'searxng'; baseUrl: string; costPerQueryEur: number; perMonthEur: number; maxQueriesPerRun: number };
  autoShortAnalysis: boolean;
  autoFullAnalysis: boolean;
  tone: string;
  internalTerms: string[];
  requireEval: boolean;
  releaseOverrides: Record<string, { configHash: string; reason: string; by: string; at: string }>;
  ideaTypes: Record<IdeaType, { shortWebSearch: boolean; blocks: Partial<Record<Block, boolean>> }>;
  review: { requireBeforeGate2: boolean };
  sourceCheck: { enabled: boolean; maxPages: number; maxChars: number; timeoutSeconds: number };
  // Edited in the quality dashboard (R4-08); kept here so saving this form does not reset it.
  qualityAlarm?: unknown;
}
type IdeaType = 'internal' | 'product';
const IDEA_TYPES: IdeaType[] = ['internal', 'product'];
const BLOCKS = ['competition', 'patents', 'positioning', 'market', 'business_case', 'risk_check', 'experiment', 'counterarguments', 'dossier_draft'] as const;
type Block = (typeof BLOCKS)[number];
const BLOCK_LABEL = labelMap('aiQuality.block', BLOCKS);
const TYPE_LABEL = labelMap('aiQuality.types', IDEA_TYPES);
interface AgentRow {
  agent: string;
  label: string;
  story: string;
  slot: Slot;
  minScore: number;
  enabled: boolean;
  release: { released: boolean; reason: string; score?: number };
  metric: { score: number; n: number; notes: string[] } | null;
  model: { provider: string; model: string; local: boolean } | { error: string };
}
interface AdminView {
  settings: AiSettings;
  templates: (Provider & { models: string[]; note: string })[];
  secrets: string[];
  platform: { anthropic: boolean; openaiCompatible: boolean; brave: boolean; secretKey: boolean; privateUrls: boolean };
  configHash: string;
  evaluation: { id: string; status: string; createdAt: string } | null;
  agents: AgentRow[];
  spent: { month: number };
  usage: { agent: string; calls: number; costEur: number; tokens: number }[];
  quality: { triage: { suggestions: number; hits: number; rate: number | null }; corrections: { kind: string; claims: number; corrected: number; rate: number | null }[] };
}

const SLOTS: Slot[] = ['fast', 'deep', 'vision', 'speech', 'confidential'];
const SLOT_LABEL = labelMap('aiAdmin.slot', SLOTS);
const SLOT_HINT = labelMap('aiAdmin.slotHint', SLOTS);
const HOSTING = labelMap('aiAdmin.hosting', ['local', 'eu', 'other'] as const);
const KIND = labelMap('aiAdmin.kind', ['builtin', 'anthropic', 'openai_compatible'] as const);
/** The built-in provider is stored with its German name; show it in the interface language. */
const providerLabel = (p: Pick<Provider, 'kind' | 'name'>) => (p.kind === 'builtin' ? t('aiAdmin.builtinName') : p.name);
const LOG_STATUS = labelMap('aiAdmin.logStatus', ['ok', 'error', 'blocked', 'budget', 'refused', 'skipped'] as const);
const dateTime = (value: string) => new Date(value).toLocaleString(intlLocale());
const pct = (n: number | null | undefined) => (n == null ? '–' : `${Math.round(n * 100)} %`);

function ModelPicker({ id, value, providers, templates, onChange, localOnly, optional }: {
  id: string; value: ModelRef | undefined; providers: Provider[]; templates: AdminView['templates']; onChange: (v: ModelRef | undefined) => void; localOnly?: boolean; optional?: boolean;
}) {
  const options = providers.filter((p) => !localOnly || p.hosting === 'local');
  const provider = providers.find((p) => p.id === value?.provider);
  const suggestions = provider?.kind === 'builtin' ? ['regelbasiert'] : (templates.find((t) => t.kind === provider?.kind && (t.baseUrl === provider?.baseUrl || t.kind === 'anthropic'))?.models ?? []);
  return (
    <div className="row" style={{ gap: 8 }}>
      <select id={id} aria-label={t('aiAdmin.provider')} value={value?.provider ?? ''} onChange={(e) => {
        const p = providers.find((x) => x.id === e.target.value);
        if (!p) return onChange(undefined);
        onChange({ provider: p.id, model: p.kind === 'builtin' ? 'regelbasiert' : value?.provider === p.id ? value.model : (templates.find((t) => t.kind === p.kind)?.models[0] ?? '') });
      }}>
        {optional && <option value="">{t('aiAdmin.taskDefault')}</option>}
        {options.map((p) => <option key={p.id} value={p.id}>{providerLabel(p)}</option>)}
      </select>
      {value && provider?.kind !== 'builtin' && (
        <>
          <input aria-label={t('aiAdmin.model')} list={`${id}-models`} value={value.model} onChange={(e) => onChange({ ...value, model: e.target.value })} style={{ maxWidth: 220 }} required />
          <datalist id={`${id}-models`}>{suggestions.map((m) => <option key={m} value={m} />)}</datalist>
        </>
      )}
    </div>
  );
}

function ProviderDialog({ initial, templates, onSave, onClose }: { initial: Provider | null; templates: AdminView['templates']; onSave: (p: Provider) => void; onClose: () => void }) {
  const [p, setP] = useState<Provider>(initial ?? { ...templates[0], models: undefined } as unknown as Provider);
  const fromTemplate = (id: string) => {
    const t = templates.find((x) => x.id === id);
    if (t) setP({ id: t.id, name: t.name, kind: t.kind, baseUrl: t.baseUrl, hosting: t.hosting, keySource: t.keySource });
  };
  const note = templates.find((t) => t.kind === p.kind && (t.baseUrl === p.baseUrl || t.kind === 'anthropic'))?.note;
  return (
    <Dialog title={initial ? t('aiAdmin.providerDialog.edit') : t('aiAdmin.providerDialog.add')} onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); onSave(p); }}>
        {!initial && (
          <Field id="tpl" label={t('aiAdmin.providerDialog.template')}>
            <select id="tpl" onChange={(e) => fromTemplate(e.target.value)} defaultValue={templates[0]?.id}>
              {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </Field>
        )}
        {note && <p className="small muted">{note}</p>}
        <div className="grid grid-2">
          <Field id="p-name" label={t('aiAdmin.providerDialog.name')}><input id="p-name" value={p.name} onChange={(e) => setP({ ...p, name: e.target.value })} required /></Field>
          <Field id="p-id" label={t('aiAdmin.providerDialog.id')} hint={t('aiAdmin.providerDialog.idHint')}><input id="p-id" value={p.id} pattern="[a-z0-9-]{1,30}" onChange={(e) => setP({ ...p, id: e.target.value })} required disabled={!!initial} /></Field>
        </div>
        <Field id="p-kind" label={t('aiAdmin.providerDialog.kind')}>
          <select id="p-kind" value={p.kind} onChange={(e) => setP({ ...p, kind: e.target.value as Provider['kind'] })}>
            <option value="anthropic">Anthropic</option>{/* texts-ok */}
            <option value="openai_compatible">{t('aiAdmin.providerDialog.openaiCompatible')}</option>
          </select>
        </Field>
        <Field id="p-url" label={t('aiAdmin.providerDialog.url')} hint={p.kind === 'anthropic' ? t('aiAdmin.providerDialog.urlHintAnthropic') : t('aiAdmin.providerDialog.urlHint')}>
          <input id="p-url" value={p.baseUrl} onChange={(e) => setP({ ...p, baseUrl: e.target.value })} required={p.kind === 'openai_compatible'} />
        </Field>
        <div className="grid grid-2">
          <Field id="p-host" label={t('aiAdmin.providerDialog.hosting')} hint={t('aiAdmin.providerDialog.hostingHint')}>
            <select id="p-host" value={p.hosting} onChange={(e) => setP({ ...p, hosting: e.target.value as Provider['hosting'] })}>
              {Object.entries(HOSTING).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </Field>
          <Field id="p-key" label={t('aiAdmin.providerDialog.key')}>
            <select id="p-key" value={p.keySource} onChange={(e) => setP({ ...p, keySource: e.target.value as Provider['keySource'] })}>
              <option value="tenant">{t('aiAdmin.keySource.tenant')}</option>
              <option value="platform">{t('aiAdmin.keySource.platform')}</option>
              <option value="none">{t('aiAdmin.keySource.none')}</option>
            </select>
          </Field>
        </div>
        <div className="row">
          <button className="primary">{t('aiAdmin.apply')}</button>
          <button type="button" onClick={onClose}>{t('common.cancel')}</button>
        </div>
      </form>
    </Dialog>
  );
}

function KeyForm({ name, isSet, label }: { name: string; isSet: boolean; label: string }) {
  const [value, setValue] = useState('');
  const [saved, setSaved] = useState(isSet);
  const { busy, error, run } = useAction();
  const save = async (v: string | null) => {
    if (await run(() => api.put('/api/admin/ai/keys', { name, value: v }))) {
      setSaved(!!v);
      setValue('');
    }
  };
  return (
    <div>
      <div className="row">
        <label htmlFor={`key-${name}`} className="small">{label}</label>
        <input id={`key-${name}`} type="password" autoComplete="off" value={value} placeholder={saved ? t('aiAdmin.key.saved') : t('aiAdmin.key.enter')} onChange={(e) => setValue(e.target.value)} style={{ maxWidth: 260 }} />
        <button type="button" onClick={() => save(value)} disabled={busy || !value}>{t('aiAdmin.key.save')}</button>
        {saved && <button type="button" className="link" onClick={() => save(null)}>{t('aiAdmin.remove')}</button>}
      </div>
      <ErrorBox error={error} />
    </div>
  );
}

function TestButton({ provider, model }: { provider: string; model: string }) {
  const [res, setRes] = useState<{ ok: boolean; model?: string; ms?: number; error?: string } | null>(null);
  const { busy, run } = useAction();
  return (
    <span className="row" style={{ gap: 6 }}>
      <button type="button" onClick={async () => setRes((await run(() => api.post<any>('/api/admin/ai/test', { provider, model }))) ?? null)} disabled={busy || !model}>{t('aiAdmin.testConnection')}</button>
      {res && <span role="status" className={`small badge ${res.ok ? 'green' : 'red'}`}>{res.ok ? `OK (${res.model}, ${res.ms} ms)` : res.error}</span>}
    </span>
  );
}

function ReleaseDialog({ agent, onClose, onDone }: { agent: AgentRow; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const { busy, error, run } = useAction();
  return (
    <Dialog title={t('aiAdmin.release.title', { label: agent.label })} onClose={onClose}>
      <form onSubmit={async (e) => { e.preventDefault(); if (await run(() => api.post('/api/admin/ai/release', { agent: agent.agent, reason }))) onDone(); }}>
        <p>{t('aiAdmin.release.text')}</p>
        <ErrorBox error={error} />
        <Field id="rel-reason" label={t('aiAdmin.release.reason')}><textarea id="rel-reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} minLength={10} required /></Field>
        <div className="row"><button className="primary" disabled={busy}>{t('aiAdmin.release.confirm')}</button><button type="button" onClick={onClose}>{t('common.cancel')}</button></div>
      </form>
    </Dialog>
  );
}

function AiLog() {
  const [agent, setAgent] = useState('');
  const [status, setStatus] = useState('');
  const { data, loading } = useLoad<any[]>(`/api/admin/ai/log?limit=100${agent ? `&agent=${agent}` : ''}${status ? `&status=${status}` : ''}`);
  return (
    <div className="stack">
      <div className="row">
        <label htmlFor="log-agent">{t('aiAdmin.log.agent')}</label>
        <input id="log-agent" value={agent} onChange={(e) => setAgent(e.target.value)} placeholder={t('aiAdmin.log.agentPlaceholder')} style={{ maxWidth: 200 }} />
        <label htmlFor="log-status">{t('aiAdmin.log.status')}</label>
        <select id="log-status" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">{t('aiAdmin.log.all')}</option>
          {Object.entries(LOG_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </div>
      {loading && !data ? <Loading /> : (
        <div className="table-wrap" tabIndex={0}>
          <table>
            <caption className="sr-only">{t('aiAdmin.log.title')}</caption>
            <thead><tr><th scope="col">{t('aiAdmin.log.time')}</th><th scope="col">{t('aiAdmin.log.agent')}</th><th scope="col">{t('aiAdmin.log.idea')}</th><th scope="col">{t('aiAdmin.model')}</th><th scope="col">{t('aiAdmin.log.status')}</th><th scope="col">{t('aiAdmin.log.tokens')}</th><th scope="col">{t('aiAdmin.log.cost')}</th><th scope="col">{t('aiAdmin.log.details')}</th></tr></thead>
            <tbody>
              {data?.map((l) => (
                <tr key={l.id}>
                  <td>{dateTime(l.createdAt)}</td>
                  <td>{l.agent}</td>
                  <td>{l.ideaNumber ? <>#{l.ideaNumber} <a className="small" href={`/api/ideas/${l.ideaId}/ai/proof.pdf`} download title={t('aiAdmin.log.proofTitle', { n: l.ideaNumber })}>{t('aiAdmin.log.proof')}</a></> : '–'}</td>
                  <td>{l.provider} / {l.model}{l.local ? ` ${t('aiAdmin.log.local')}` : ''}</td>
                  <td>{LOG_STATUS[l.status] ?? l.status}{l.error ? `: ${l.error}` : ''}</td>
                  <td>{l.inputTokens + l.outputTokens}{l.searchQueries ? ` · ${t('aiAdmin.log.searches', { n: l.searchQueries })}` : ''}</td>
                  <td>{Number(l.costEur).toFixed(4)} €</td>
                  <td>
                    <details>
                      <summary>{t('aiAdmin.log.summary')}</summary>
                      <pre className="pre small">{JSON.stringify({ [t('aiAdmin.log.json.input')]: l.input, [t('aiAdmin.log.json.sources')]: l.sources, [t('aiAdmin.log.json.tools')]: l.tools, [t('aiAdmin.log.json.warnings')]: l.warnings, [t('aiAdmin.log.json.output')]: l.output }, null, 2).slice(0, 8000)}</pre>
                    </details>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="small muted">{t('aiAdmin.log.retention')}</p>
    </div>
  );
}

interface KindQuality {
  kind: string;
  label: string;
  reviews: { unchecked: number; checked: number; corrected: number };
  ratings: { n: number; helpful: number | null; rate: number | null; belowMinimum: boolean };
  expand: { views: number; opens: number; rate: number | null };
  sources: { numbers: number; numbersSourced: number; share: number | null; sourcesChecked: number; reachable: number; quoteFound: number; claimsChecked: number; claimsConfirmed: number } | null;
}
interface QualityView {
  minGroupSize: number;
  kinds: KindQuality[];
  samples: { id: string; month: string; kind: string; ideaId: string | null; ideaNumber: number | null; ideaTitle: string | null; verdict: 'correct' | 'minor' | 'wrong' | null; note: string | null }[];
  samplesRated: { n: number; correct: number; minor: number; wrong: number };
}

const share = (part: number, n: number) => (n ? t('aiQuality.view.of', { pct: pct(part / n), part, n }) : '–');

/** Quality view (Einstellungen › KI › Qualität, R2-44, R2-46): aggregated, never per person. */
function QualityInUse() {
  const { data, reload } = useLoad<QualityView>('/api/admin/ai/quality');
  if (!data) return null;
  const VERDICT = labelMap('aiQuality.sample', ['correct', 'minor', 'wrong'] as const);
  return (
    <div className="stack">
      <h4>{t('aiQuality.view.title')}</h4>
      <p className="small muted">{t('aiQuality.view.hint', { n: data.minGroupSize })}</p>
      {data.kinds.length === 0 ? <p className="small muted">{t('aiQuality.view.empty')}</p> : (
        <div className="table-wrap" tabIndex={0}>
          <table>
            <caption className="sr-only">{t('aiQuality.view.caption')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('aiQuality.view.block')}</th><th scope="col">{t('aiQuality.view.reviews')}</th><th scope="col">{t('aiQuality.view.helpful')}</th>
                <th scope="col">{t('aiQuality.view.expand')}</th><th scope="col">{t('aiQuality.view.numbers')}</th><th scope="col">{t('aiQuality.view.reachable')}</th>
                <th scope="col">{t('aiQuality.view.quotes')}</th><th scope="col">{t('aiQuality.view.facts')}</th>
              </tr>
            </thead>
            <tbody>
              {data.kinds.map((k) => (
                <tr key={k.kind}>
                  <th scope="row">{KIND_LABEL[k.kind] ?? k.label}</th>
                  <td>{k.reviews.unchecked} / {k.reviews.checked} / {k.reviews.corrected}</td>
                  <td>{k.ratings.rate != null ? share(k.ratings.helpful ?? 0, k.ratings.n) : k.ratings.belowMinimum ? t('aiQuality.view.belowMin', { n: data.minGroupSize }) : '–'}</td>
                  <td>{k.expand.rate != null ? share(k.expand.opens, k.expand.views) : k.expand.views ? t('aiQuality.view.belowMin', { n: data.minGroupSize }) : '–'}</td>
                  <td>{k.sources ? share(k.sources.numbersSourced, k.sources.numbers) : '–'}</td>
                  <td>{k.sources ? share(k.sources.reachable, k.sources.sourcesChecked) : '–'}</td>
                  <td>{k.sources ? share(k.sources.quoteFound, k.sources.sourcesChecked) : '–'}</td>
                  <td>{k.sources ? share(k.sources.claimsConfirmed, k.sources.claimsChecked) : '–'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <h4>{t('aiQuality.samples.title')}</h4>
      <p className="small muted">{t('aiQuality.samples.hint')}</p>
      {data.samplesRated.n > 0 && <p className="small">{t('aiQuality.samples.summary', data.samplesRated)}</p>}
      {data.samples.length === 0 ? <p className="small muted">{t('aiQuality.samples.empty')}</p> : (
        <ul className="idea-list">
          {data.samples.map((s) => (
            <li key={s.id} className="stack" style={{ gap: 4 }}>
              <span>
                {s.month} · {s.ideaId ? <Link to={`/ideen/${s.ideaId}/steckbrief/analysen`}>#{s.ideaNumber} {s.ideaTitle ?? t('aiQuality.samples.confidential')}</Link> : '–'} · {KIND_LABEL[s.kind] ?? s.kind}
                {' · '}<span className={`badge ${s.verdict === 'correct' ? 'green' : s.verdict === 'wrong' ? 'red' : s.verdict ? 'yellow' : ''}`}>{s.verdict ? VERDICT[s.verdict] : t('aiQuality.samples.open')}</span>
              </span>
              {!s.verdict && <SampleForm sampleId={s.id} month={s.month} verdict={s.verdict} note={s.note} onSaved={() => void reload()} />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function AiAdmin() {
  const { data, error, loading, reload } = useLoad<AdminView>('/api/admin/ai');
  const [s, setS] = useState<AiSettings | null>(null);
  const [editing, setEditing] = useState<Provider | 'new' | null>(null);
  const [releasing, setReleasing] = useState<AgentRow | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const save = useAction();
  useEffect(() => {
    if (data) setS(data.settings);
  }, [data]);
  if (loading && !data) return <Loading />;
  if (!data || !s) return <ErrorBox error={error} />;

  const set = (patch: Partial<AiSettings>) => setS({ ...s, ...patch });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaved(null);
    const res = await save.run(() => api.put<{ evaluationQueued: boolean }>('/api/admin/ai', s));
    if (res) {
      setSaved(res.evaluationQueued ? t('aiAdmin.savedWithEval') : t('aiAdmin.saved'));
      await reload();
    }
  };
  const providers = s.providers.some((p) => p.id === 'builtin') ? s.providers : [{ id: 'builtin', name: t('aiAdmin.builtinName'), kind: 'builtin', baseUrl: '', hosting: 'local', keySource: 'none' } as Provider, ...s.providers];
  const upsertProvider = (p: Provider) => {
    const exists = s.providers.some((x) => x.id === p.id);
    set({ providers: exists ? s.providers.map((x) => (x.id === p.id ? p : x)) : [...s.providers, p] });
    setEditing(null);
  };
  const removeProvider = (id: string) => set({ providers: s.providers.filter((p) => p.id !== id) });
  const used = new Set([...Object.values(s.models).map((m) => m.provider), ...Object.values(s.agents).map((a) => a.model?.provider)]);

  return (
    <>
    <form onSubmit={submit} className="stack" aria-labelledby="h-ai-admin">
      <h2 id="h-ai-admin">{t('aiAdmin.title')}</h2>
      <p className="muted">{t('aiAdmin.intro')}</p>
      <label className="check"><input type="checkbox" checked={s.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> {t('aiAdmin.enabled')}</label>

      <fieldset>
        <legend>{t('aiAdmin.providers')}</legend>
        {!data.platform.secretKey && <p className="alert warn small">{t('aiAdmin.noSecretKey')}</p>}
        <ul className="idea-list">
          {providers.map((p) => (
            <li key={p.id} className="stack" style={{ gap: 6 }}>
              <div className="row spread">
                <span><strong>{providerLabel(p)}</strong> <span className="badge">{KIND[p.kind]}</span> <span className={`badge ${p.hosting === 'local' ? 'green' : p.hosting === 'eu' ? 'accent' : ''}`}>{HOSTING[p.hosting]}</span>{p.baseUrl && <span className="small muted"> {p.baseUrl}</span>}</span>
                {p.kind !== 'builtin' && (
                  <span className="row">
                    <button type="button" className="link" onClick={() => setEditing(p)}>{t('aiAdmin.edit')}</button>
                    <button type="button" className="link" onClick={() => removeProvider(p.id)} disabled={used.has(p.id)} title={used.has(p.id) ? t('aiAdmin.inUse') : undefined}>{t('aiAdmin.remove')}</button>
                  </span>
                )}
              </div>
              {p.kind !== 'builtin' && p.keySource === 'tenant' && <KeyForm name={`provider:${p.id}`} isSet={data.secrets.includes(`provider:${p.id}`)} label={t('aiAdmin.apiKey')} />}
              {p.kind !== 'builtin' && p.keySource === 'platform' && (
                <span className="small muted">{t('aiAdmin.platformKey')} {(p.kind === 'anthropic' ? data.platform.anthropic : data.platform.openaiCompatible) ? t('aiAdmin.platformKey.present') : t('aiAdmin.platformKey.missing')}</span>
              )}
              {p.kind !== 'builtin' && data.settings.providers.some((x) => x.id === p.id) && <TestButton provider={p.id} model={Object.values(s.models).find((m) => m.provider === p.id)?.model ?? data.templates.find((t) => t.kind === p.kind)?.models[0] ?? ''} />}
            </li>
          ))}
        </ul>
        <button type="button" onClick={() => setEditing('new')}>{t('aiAdmin.providerDialog.add')}</button>
        {!data.platform.privateUrls && <p className="hint">{t('aiAdmin.privateUrls')}</p>}
      </fieldset>

      <fieldset>
        <legend>{t('aiAdmin.modelPerTask')}</legend>
        {SLOTS.map((slot) => (
          <Field key={slot} id={`slot-${slot}`} label={SLOT_LABEL[slot]} hint={SLOT_HINT[slot]}>
            <ModelPicker id={`slot-${slot}`} value={s.models[slot]} providers={providers} templates={data.templates} localOnly={slot === 'confidential'} onChange={(v) => v && set({ models: { ...s.models, [slot]: v } })} />
          </Field>
        ))}
      </fieldset>

      <fieldset>
        <legend>{t('aiAdmin.agents.title')}</legend>
        <p className="small muted">{t('aiAdmin.agents.hint')}</p>
        <label className="check"><input type="checkbox" checked={s.requireEval} onChange={(e) => set({ requireEval: e.target.checked })} /> {t('aiAdmin.agents.requireEval')}</label>
        <div className="table-wrap" tabIndex={0}>
          <table>
            <caption className="sr-only">{t('aiAdmin.agents.caption')}</caption>
            <thead><tr><th scope="col">{t('aiAdmin.log.agent')}</th><th scope="col">{t('aiAdmin.agents.on')}</th><th scope="col">{t('aiAdmin.model')}</th><th scope="col">{t('aiAdmin.agents.override')}</th><th scope="col">{t('aiAdmin.agents.minScore')}</th><th scope="col">{t('aiAdmin.agents.result')}</th><th scope="col">{t('aiAdmin.agents.release')}</th></tr></thead>
            <tbody>
              {data.agents.map((a) => {
                const cfg = s.agents[a.agent] ?? { enabled: true };
                const setAgent = (patch: Partial<typeof cfg>) => set({ agents: { ...s.agents, [a.agent]: { ...cfg, ...patch } } });
                return (
                  <tr key={a.agent}>
                    <th scope="row">{a.label} <span className="small muted">{a.story}</span></th>
                    <td><input type="checkbox" aria-label={t('aiAdmin.agents.enabledFor', { label: a.label })} checked={cfg.enabled !== false} onChange={(e) => setAgent({ enabled: e.target.checked })} /></td>
                    <td className="small">{'error' in a.model ? <span className="badge red">{a.model.error}</span> : `${a.model.provider} / ${a.model.model}`}</td>
                    <td>{a.slot !== 'confidential' && <ModelPicker id={`agent-${a.agent}`} value={cfg.model} providers={providers} templates={data.templates} optional onChange={(v) => setAgent({ model: v })} />}</td>
                    <td><input type="number" aria-label={t('aiAdmin.agents.minScoreFor', { label: a.label })} min={0} max={100} value={Math.round((cfg.minScore ?? a.minScore) * 100)} onChange={(e) => setAgent({ minScore: Number(e.target.value) / 100 })} style={{ width: 70 }} /> %</td>
                    <td>{a.metric ? pct(a.metric.score) : '–'}</td>
                    <td>
                      {a.release.released
                        ? <span className="badge green">{a.release.reason === 'override' ? t('aiAdmin.agents.releasedOverride') : t('aiAdmin.agents.released')}</span>
                        : a.release.reason === 'pending' ? <span className="badge yellow">{t('aiAdmin.agents.pending')}</span>
                        : <><span className="badge red">{t('aiAdmin.agents.notReleased')}</span> <button type="button" className="link small" onClick={() => setReleasing(a)}>{t('aiAdmin.agents.releaseAnyway')}</button></>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </fieldset>

      <fieldset>
        <legend>{t('aiAdmin.costs.title')}</legend>
        <p className="small">{t('aiAdmin.costs.thisMonth')} <strong>{data.spent.month.toFixed(2)} €</strong> {t('aiAdmin.costs.ofBudget', { budget: s.budget.perMonthEur })}</p>
        <div className="grid grid-2">
          <Field id="b-idea" label={t('aiAdmin.costs.perIdea')}><input id="b-idea" type="number" min={0} step="0.5" value={s.budget.perIdeaEur} onChange={(e) => set({ budget: { ...s.budget, perIdeaEur: Number(e.target.value) } })} /></Field>
          <Field id="b-month" label={t('aiAdmin.costs.perMonth')}><input id="b-month" type="number" min={0} step="1" value={s.budget.perMonthEur} onChange={(e) => set({ budget: { ...s.budget, perMonthEur: Number(e.target.value) } })} /></Field>
        </div>
        <details>
          <summary>{t('aiAdmin.prices.title')}</summary>
          <p className="small muted">{t('aiAdmin.prices.hint')}</p>
          <div className="table-wrap" tabIndex={0}>
            <table>
              <thead><tr><th scope="col">{t('aiAdmin.model')}</th><th scope="col">{t('aiAdmin.prices.input')}</th><th scope="col">{t('aiAdmin.prices.output')}</th><th scope="col"><span className="sr-only">{t('aiAdmin.prices.action')}</span></th></tr></thead>
              <tbody>
                {s.prices.map((p, i) => (
                  <tr key={i}>
                    <td><input aria-label={t('aiAdmin.model')} value={p.model} onChange={(e) => set({ prices: s.prices.map((x, n) => (n === i ? { ...x, model: e.target.value } : x)) })} /></td>
                    <td><input aria-label={t('aiAdmin.prices.inputPrice')} type="number" min={0} step="0.01" value={p.inputPerMTok} onChange={(e) => set({ prices: s.prices.map((x, n) => (n === i ? { ...x, inputPerMTok: Number(e.target.value) } : x)) })} style={{ width: 90 }} /></td>
                    <td><input aria-label={t('aiAdmin.prices.outputPrice')} type="number" min={0} step="0.01" value={p.outputPerMTok} onChange={(e) => set({ prices: s.prices.map((x, n) => (n === i ? { ...x, outputPerMTok: Number(e.target.value) } : x)) })} style={{ width: 90 }} /></td>
                    <td><button type="button" className="link" onClick={() => set({ prices: s.prices.filter((_, n) => n !== i) })}>{t('aiAdmin.remove')}</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button type="button" onClick={() => set({ prices: [...s.prices, { model: '', inputPerMTok: 0, outputPerMTok: 0 }] })}>{t('aiAdmin.prices.add')}</button>
          <div className="grid grid-2">
            <Field id="fb-in" label={t('aiAdmin.prices.fallbackInput')}><input id="fb-in" type="number" min={0} step="0.01" value={s.fallbackPrice.inputPerMTok} onChange={(e) => set({ fallbackPrice: { ...s.fallbackPrice, inputPerMTok: Number(e.target.value) } })} /></Field>
            <Field id="fb-out" label={t('aiAdmin.prices.fallbackOutput')}><input id="fb-out" type="number" min={0} step="0.01" value={s.fallbackPrice.outputPerMTok} onChange={(e) => set({ fallbackPrice: { ...s.fallbackPrice, outputPerMTok: Number(e.target.value) } })} /></Field>
          </div>
        </details>
        {data.usage.length > 0 && (
          <details>
            <summary>{t('aiAdmin.usage.title')}</summary>
            <ul className="small">{data.usage.map((u) => <li key={u.agent}>{u.agent}: {t('aiAdmin.usage.line', { calls: u.calls, tokens: u.tokens, cost: u.costEur.toFixed(2) })}</li>)}</ul>
          </details>
        )}
      </fieldset>

      <fieldset>
        <legend>{t('aiAdmin.search.title')}</legend>
        <p className="small muted">{t('aiAdmin.search.hint')}</p>
        <Field id="s-kind" label={t('aiAdmin.search.provider')}>
          <select id="s-kind" value={s.search.kind} onChange={(e) => set({ search: { ...s.search, kind: e.target.value as AiSettings['search']['kind'] } })}>
            <option value="none">{t('aiAdmin.search.none')}</option>
            <option value="brave">Brave Search API</option>{/* texts-ok */}
            <option value="searxng">{t('aiAdmin.search.searxng')}</option>
          </select>
        </Field>
        {s.search.kind === 'searxng' && <Field id="s-url" label={t('aiAdmin.search.searxngUrl')}><input id="s-url" value={s.search.baseUrl} onChange={(e) => set({ search: { ...s.search, baseUrl: e.target.value } })} required /></Field>}
        {s.search.kind === 'brave' && (data.platform.brave ? <p className="small">{t('aiAdmin.search.platformKey')}</p> : null)}
        {s.search.kind === 'brave' && <KeyForm name="search" isSet={data.secrets.includes('search')} label={t('aiAdmin.search.key')} />}
        <div className="grid grid-2">
          <Field id="s-cost" label={t('aiAdmin.search.costPerQuery')}><input id="s-cost" type="number" min={0} step="0.001" value={s.search.costPerQueryEur} onChange={(e) => set({ search: { ...s.search, costPerQueryEur: Number(e.target.value) } })} /></Field>
          <Field id="s-month" label={t('aiAdmin.search.perMonth')}><input id="s-month" type="number" min={0} value={s.search.perMonthEur} onChange={(e) => set({ search: { ...s.search, perMonthEur: Number(e.target.value) } })} /></Field>
          <Field id="s-max" label={t('aiAdmin.search.maxQueries')}><input id="s-max" type="number" min={0} max={20} value={s.search.maxQueriesPerRun} onChange={(e) => set({ search: { ...s.search, maxQueriesPerRun: Number(e.target.value) } })} /></Field>
        </div>
        <Field id="s-terms" label={t('aiAdmin.search.terms')} hint={t('aiAdmin.search.termsHint')}>
          <textarea id="s-terms" rows={4} value={s.internalTerms.join('\n')} onChange={(e) => set({ internalTerms: e.target.value.split('\n').map((x) => x.trim()).filter((x) => x.length >= 2) })} />
        </Field>
      </fieldset>

      <fieldset>
        <legend>{t('aiQuality.types.title')}</legend>
        <p className="small muted">{t('aiQuality.types.hint')}</p>
        <div className="table-wrap" tabIndex={0}>
          <table>
            <caption className="sr-only">{t('aiQuality.types.caption')}</caption>
            <thead><tr><th scope="col">{t('aiQuality.types.step')}</th>{IDEA_TYPES.map((it) => <th key={it} scope="col">{TYPE_LABEL[it]}</th>)}</tr></thead>
            <tbody>
              <tr>
                <th scope="row">{t('aiQuality.types.shortWebSearch')}</th>
                {IDEA_TYPES.map((it) => (
                  <td key={it}><input type="checkbox" aria-label={t('aiQuality.types.toggle', { step: t('aiQuality.types.shortWebSearch'), type: TYPE_LABEL[it] })} checked={s.ideaTypes[it].shortWebSearch} onChange={(e) => set({ ideaTypes: { ...s.ideaTypes, [it]: { ...s.ideaTypes[it], shortWebSearch: e.target.checked } } })} /></td>
                ))}
              </tr>
              {BLOCKS.map((b) => (
                <tr key={b}>
                  <th scope="row">{BLOCK_LABEL[b]}</th>
                  {IDEA_TYPES.map((it) => (
                    <td key={it}><input type="checkbox" aria-label={t('aiQuality.types.toggle', { step: BLOCK_LABEL[b], type: TYPE_LABEL[it] })} checked={s.ideaTypes[it].blocks[b] !== false} onChange={(e) => set({ ideaTypes: { ...s.ideaTypes, [it]: { ...s.ideaTypes[it], blocks: { ...s.ideaTypes[it].blocks, [b]: e.target.checked } } } })} /></td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </fieldset>

      <fieldset>
        <legend>{t('aiQuality.sourceCheck.title')}</legend>
        <p className="small muted">{t('aiQuality.sourceCheck.hint')}</p>
        <label className="check"><input type="checkbox" checked={s.sourceCheck.enabled} onChange={(e) => set({ sourceCheck: { ...s.sourceCheck, enabled: e.target.checked } })} /> {t('aiQuality.sourceCheck.enabled')}</label>
        <div className="grid grid-2">
          <Field id="sc-pages" label={t('aiQuality.sourceCheck.maxPages')}><input id="sc-pages" type="number" min={0} max={5} value={s.sourceCheck.maxPages} onChange={(e) => set({ sourceCheck: { ...s.sourceCheck, maxPages: Number(e.target.value) } })} /></Field>
          <Field id="sc-chars" label={t('aiQuality.sourceCheck.maxChars')}><input id="sc-chars" type="number" min={1000} max={20000} step={1000} value={s.sourceCheck.maxChars} onChange={(e) => set({ sourceCheck: { ...s.sourceCheck, maxChars: Number(e.target.value) } })} /></Field>
          <Field id="sc-timeout" label={t('aiQuality.sourceCheck.timeout')}><input id="sc-timeout" type="number" min={1} max={30} value={s.sourceCheck.timeoutSeconds} onChange={(e) => set({ sourceCheck: { ...s.sourceCheck, timeoutSeconds: Number(e.target.value) } })} /></Field>
        </div>
      </fieldset>

      <fieldset>
        <legend>{t('aiAdmin.auto.title')}</legend>
        <label className="check"><input type="checkbox" checked={s.autoShortAnalysis} onChange={(e) => set({ autoShortAnalysis: e.target.checked })} /> {t('aiAdmin.auto.short')}</label>
        <label className="check"><input type="checkbox" checked={s.autoFullAnalysis} onChange={(e) => set({ autoFullAnalysis: e.target.checked })} /> {t('aiAdmin.auto.full')}</label>
        <Field id="tone" label={t('aiAdmin.auto.tone')}><textarea id="tone" rows={2} value={s.tone} onChange={(e) => set({ tone: e.target.value })} /></Field>
        <label className="check"><input type="checkbox" checked={s.review.requireBeforeGate2} onChange={(e) => set({ review: { requireBeforeGate2: e.target.checked } })} /> {t('aiQuality.reviewSetting')}</label>
      </fieldset>

      <ErrorBox error={save.error} />
      {saved && <div className="alert info" role="status">{saved}</div>}
      <div><button className="primary" disabled={save.busy}>{t('aiAdmin.save')}</button></div>

      <section className="card" aria-labelledby="h-quality">
        <h3 id="h-quality">{t('aiAdmin.quality.title')}</h3>
        <p className="small">{t('aiAdmin.quality.triage')} <strong>{pct(data.quality.triage.rate)}</strong> {t('aiAdmin.quality.triageCount', { hits: data.quality.triage.hits, n: data.quality.triage.suggestions })}</p>
        {data.quality.corrections.length > 0 && (
          <p className="small">{t('aiAdmin.quality.corrections', { list: data.quality.corrections.map((c) => `${c.kind} ${pct(c.rate)}`).join(', ') })}</p>
        )}
        <QualityInUse />
        <EvalReports />
      </section>

      <section className="card" aria-labelledby="h-ai-log">
        <h3 id="h-ai-log">{t('aiAdmin.log.title')}</h3>
        <AiLog />
      </section>

      {editing && <ProviderDialog initial={editing === 'new' ? null : editing} templates={data.templates} onSave={upsertProvider} onClose={() => setEditing(null)} />}
      {releasing && <ReleaseDialog agent={releasing} onClose={() => setReleasing(null)} onDone={() => { setReleasing(null); void reload(); }} />}
    </form>
    {/* Quality dashboard with its own alarm form (R4-08), outside the settings form. */}
    <QualityDashboard onAlarmSaved={(alarm) => setS((cur) => (cur ? { ...cur, qualityAlarm: alarm } : cur))} />
    {/* Quality check and fallback model, own form; the settings form keeps the saved values. */}
    <EvalSettings onSaved={(q) => setS((cur) => (cur ? { ...cur, ...q } : cur))} />
    </>
  );
}
