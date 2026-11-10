import { useEffect, useState, type FormEvent } from 'react';
import { ApiError, api, type Criterion } from '../api';
import { ErrorBox, Field, Loading, readBase64, useAction, useLoad } from '../components';
import { CHANNEL_KINDS, ROLES } from '../labels';
import { formatDateTime, labelMap, t } from '../i18n';
import { useSession } from '../session';
import { AiAdmin } from '../ai/AiAdmin';
import { ImportAssist } from '../ai/ImportAssist';
import { GuaranteeSettings } from './Guarantee';
import { Integrations } from './Integrations';
import { ChatAdmin } from './ChatSettings';
import { IdentityAdmin } from './IdentityAdmin';
import { SupportAccess } from './SupportAccess';
import { AreasAdmin, type Area, type ScopedRole } from './AreasAdmin';
import { ComplianceAdmin } from './Legal';
import { BillingAdmin } from './Billing';
import { ProcessAssistant } from './ProcessAssistant';
import { UpgradeHint, usePlan } from '../plan';
import { AuditLog, SecuritySettings, SiemSettings } from './SecurityAdmin';
import { hasRole } from '../session';
import { BulkBar, PeopleImport } from './PeopleTools';
import { Offboarding, TenantExport } from './TenantLifecycle';

// Tenant settings (R1-04), users and roles (R1-09, R1-10), audit log (R1-06) and data export (R1-43).

interface Settings {
  /** Version for the conflict check (R3-41). */
  version?: number;
  timezone: string;
  locale?: 'de' | 'en';
  deadlines: Record<string, number>;
  thresholds: Record<string, number>;
  topics: string[];
  holidays: string[];
  targetChannels: { id: string; name: string; kind: string; contact: string; url: string }[];
  boundaryRules: { category: string; label: string; channelKind: string; keywords: string[] }[];
  texts: { fast_lane: string; elaborate: string; forward: string; reject: string; privacyNotice: string; faq: { q: string; a: string }[] };
  minGroupSize: number;
  requireMfaForAdmins: boolean;
  guarantee: { enabled: boolean; workdays: number; alertBelowPercent: number };
  challenges: { crowdRating: boolean; kgCo2PerKwh?: number; eurPerKwh?: number };
  gamification?: { pointsSubmit: number; pointsComment: number; pointsRating: number };
  benchmark?: { share: boolean };
  retention: { closedIdeasMonths: number; notificationsMonths: number; anonymizeDeactivatedAfterDays: number };
  elaboration: Record<string, number>;
  scorecard: { criteria: Criterion[] };
  baselines: { submission: number | null; gate1: number | null; gate2: number | null; implementation: number | null; gate3: number | null; note: string };
}

// Throughput before the pilot (R2-41), shown as a dashed line in the dashboard.
const BASELINE_LABELS = labelMap('admin.baseline', ['submission', 'gate1', 'gate2', 'implementation', 'gate3'] as const);

// Elaboration, committee and impact review (R2-01, R2-02, R2-04, R2-06, R2-07).
const ELABORATION_LABELS = labelMap('admin.elab', ['timeboxWeeks', 'mentorWarnActive', 'lockMinutes', 'meetingMaxIdeas', 'meetingPackWorkdays', 'experimentReminderWorkdays', 'impactReviewMonths'] as const);
const ELABORATION_HINTS: Record<string, () => string> = { timeboxWeeks: () => t('admin.elabHint.timeboxWeeks') };

const RETENTION_KEYS = ['closedIdeasMonths', 'notificationsMonths', 'anonymizeDeactivatedAfterDays'] as const;
const RETENTION_LABELS = labelMap('admin.retention', RETENTION_KEYS);
const RETENTION_HINTS = labelMap('admin.retentionHint', RETENTION_KEYS);

const TABS = ['process', 'processAi', 'elaboration', 'ai', 'topics', 'channels', 'boundary', 'texts', 'users', 'areas', 'identity', 'security', 'import', 'audit', 'chat', 'integrations', 'support', 'legal', 'plan', 'data'] as const;
type Tab = (typeof TABS)[number];
const TAB_LABELS = labelMap('admin.tab', TABS);
// Five groups instead of one row of 20 tabs (usability review 10/2026).
const GROUPS: { key: string; tabs: Tab[] }[] = [
  { key: 'process', tabs: ['process', 'elaboration', 'topics', 'channels', 'boundary', 'texts', 'processAi'] },
  { key: 'ai', tabs: ['ai'] },
  { key: 'people', tabs: ['users', 'areas', 'identity', 'security', 'support'] },
  { key: 'connections', tabs: ['import', 'chat', 'integrations'] },
  { key: 'contract', tabs: ['plan', 'legal', 'data', 'audit'] },
];
const GROUP_LABELS = labelMap('admin.group', ['process', 'ai', 'people', 'connections', 'contract'] as const);

const DEADLINE_LABELS = labelMap('admin.deadline', ['gate1Workdays', 'elaborationWorkdays', 'reminderWorkdaysBefore', 'questionTimeoutWorkdays', 'maxQuestionRounds', 'maxParkMonths'] as const);

const THRESHOLD_LABELS = labelMap('admin.threshold', ['fastLaneMaxPersonDays', 'fastLaneMaxEuro', 'delegationMaxPersonDays', 'delegationMaxEuro'] as const);

const LANE_LABELS = labelMap('admin.lane', ['fast_lane', 'elaborate', 'forward', 'reject'] as const);

export function Admin() {
  const { me } = useSession();
  // People administration (enterprise): the role user_admin sees only the people tab.
  const tabs: readonly Tab[] = hasRole(me, 'admin') ? TABS : ['users'];
  // ?tab=plan opens a tab directly, e.g. from the package banner (AP-18).
  const [tab, setTab] = useState<Tab>(() => {
    const wanted = new URLSearchParams(window.location.search).get('tab');
    return (tabs as readonly string[]).includes(wanted ?? '') ? (wanted as Tab) : tabs[0];
  });
  // Features outside the package show an upgrade hint instead of the page (R3-05).
  const features = usePlan()?.features ?? {};
  const off = (...f: (keyof typeof features)[]) => f.every((x) => features[x] === false);
  const [filter, setFilter] = useState('');
  const match = (k: Tab) => !filter.trim() || TAB_LABELS[k].toLowerCase().includes(filter.trim().toLowerCase());
  const groups = GROUPS.map((g) => ({ ...g, tabs: g.tabs.filter((k) => tabs.includes(k) && match(k)) })).filter((g) => g.tabs.length);
  const single = tabs.length === 1;
  return (
    <div className="stack">
      <h1>{single ? TAB_LABELS[tabs[0]] : t('admin.title')}</h1>
      <div className={single ? '' : 'settings-layout'}>
        {!single && (
          <aside className="settings-nav">
            <label htmlFor="settings-filter" className="sr-only">{t('admin.filter')}</label>
            <input id="settings-filter" type="search" placeholder={t('admin.filter')} value={filter} onChange={(e) => setFilter(e.target.value)} />
            {groups.map((g) => (
              <div key={g.key}>
                <h2 className="settings-group" id={`sg-${g.key}`}>{GROUP_LABELS[g.key]}</h2>
                <div role="tablist" aria-labelledby={`sg-${g.key}`} aria-orientation="vertical">
                  {g.tabs.map((k) => (
                    <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>{TAB_LABELS[k]}</button>
                  ))}
                </div>
              </div>
            ))}
            {groups.length === 0 && <p className="small muted">{t('admin.filterEmpty')}</p>}
          </aside>
        )}
        <div className="stack">
      {(['process', 'elaboration', 'topics', 'channels', 'boundary', 'texts'] as Tab[]).includes(tab) && <SettingsEditor tab={tab} />}
      {tab === 'ai' && <AiAdmin />}
      {tab === 'users' && <Users />}
      {tab === 'areas' && <AreasAdmin />}
      {tab === 'processAi' && <ProcessAssistant />}
      {tab === 'identity' && (off('sso', 'scim') ? <UpgradeHint feature="sso" /> : <IdentityAdmin />)}
      {tab === 'import' && <><Import /><ImportAssist /></>}
      {tab === 'security' && <SecuritySettings />}
      {tab === 'audit' && <><AuditLog /><SiemSettings /></>}
      {tab === 'chat' && (off('chat') ? <UpgradeHint feature="chat" /> : <ChatAdmin />)}
      {tab === 'integrations' && (off('api', 'webhooks') ? <UpgradeHint feature="api" /> : <Integrations />)}
      {tab === 'support' && <SupportAccess />}
      {tab === 'legal' && <ComplianceAdmin />}
      {tab === 'plan' && <BillingAdmin />}
      {tab === 'data' && <DataTab />}
        </div>
      </div>
    </div>
  );
}

function SettingsEditor({ tab }: { tab: Tab }) {
  const { refresh } = useSession();
  const { data, error, loading, setData, reload } = useLoad<Settings>('/api/admin/settings');
  const { busy, error: saveError, run } = useAction();
  const [saved, setSaved] = useState(false);
  const [topics, setTopics] = useState('');
  const [holidays, setHolidays] = useState('');
  useEffect(() => {
    if (!data) return;
    setTopics(data.topics.join('\n'));
    setHolidays(data.holidays.join('\n'));
  }, [data]);
  if (loading && !data) return <Loading />;
  if (!data) return <ErrorBox error={error} />;
  const s = data;
  const update = (patch: Partial<Settings>) => {
    setSaved(false);
    setData({ ...s, ...patch });
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    const body = {
      ...s,
      topics: topics.split('\n').map((x) => x.trim()).filter(Boolean),
      holidays: holidays.split('\n').map((x) => x.trim()).filter(Boolean),
    };
    // Versioned settings (R3-41): on a concurrent change the server answers 409; the message
    // stays visible and the current version is loaded.
    const r = await run(() => api.put<Settings>('/api/admin/settings', body).catch((e: unknown) => {
      if (e instanceof ApiError && e.code === 'SETTINGS_CONFLICT') {
        setSaved(false);
        void reload();
      }
      throw e;
    }));
    if (r) {
      setData(r);
      setSaved(true);
      await refresh();
    }
  };

  return (
    <form className="card" onSubmit={save}>
      <ErrorBox error={saveError} />
      {saveError?.details ? <pre className="small">{JSON.stringify(saveError.details, null, 2)}</pre> : null}
      {saved && <div className="alert success" role="status">{t('admin.saved')}</div>}

      {tab === 'process' && (
        <>
          <h2>{t('admin.process.deadlines')}</h2>
          <div className="grid grid-3">
            {Object.entries(DEADLINE_LABELS).map(([k, label]) => (
              <Field key={k} id={k} label={label}>
                <input id={k} type="number" min={0} value={s.deadlines[k]} onChange={(e) => update({ deadlines: { ...s.deadlines, [k]: Number(e.target.value) } })} />
              </Field>
            ))}
          </div>
          <h2>{t('admin.process.thresholds')}</h2>
          <div className="grid grid-3">
            {Object.entries(THRESHOLD_LABELS).map(([k, label]) => (
              <Field key={k} id={k} label={label}>
                <input id={k} type="number" min={0} value={s.thresholds[k]} onChange={(e) => update({ thresholds: { ...s.thresholds, [k]: Number(e.target.value) } })} />
              </Field>
            ))}
          </div>
          <h2>{t('admin.process.privacy')}</h2>
          <div className="grid grid-3">
            <Field id="minGroup" label={t('admin.process.minGroup')} hint={t('admin.process.minGroupHint')}>
              <input id="minGroup" type="number" min={5} value={s.minGroupSize} onChange={(e) => update({ minGroupSize: Number(e.target.value) })} />
            </Field>
            <Field id="tz" label={t('admin.process.timezone')}>
              <input id="tz" type="text" value={s.timezone} onChange={(e) => update({ timezone: e.target.value })} />
            </Field>
            <Field id="workspaceLocale" label={t('admin.process.workspaceLocale')} hint={t('admin.process.workspaceLocaleHint')}>
              <select id="workspaceLocale" value={s.locale ?? 'de'} onChange={(e) => update({ locale: e.target.value as 'de' | 'en' })} aria-describedby="workspaceLocale-hint">
                <option value="de" lang="de">Deutsch</option>{/* texts-ok */}
                <option value="en" lang="en">English</option>{/* texts-ok */}
              </select>
            </Field>
          </div>
          <label className="check">
            <input type="checkbox" checked={s.requireMfaForAdmins} onChange={(e) => update({ requireMfaForAdmins: e.target.checked })} /> {t('admin.process.requireMfa')}
          </label>
          <h2 style={{ marginTop: 20 }}>{t('admin.process.participation')}</h2>
          <label className="check">
            <input type="checkbox" checked={s.challenges?.crowdRating ?? true} onChange={(e) => update({ challenges: { ...s.challenges, crowdRating: e.target.checked } })} /> {t('admin.process.crowdRating')}
          </label>
          {/* Conversion factors of the sustainability challenge (R3-32). */}
          <fieldset>
            <legend>{t('usecases.admin.factorsTitle')}</legend>
            <p className="small muted">{t('usecases.admin.factorsHint')}</p>
            <div className="grid grid-3">
              <Field id="factor-co2" label={t('usecases.admin.kgCo2PerKwh')}>
                <input id="factor-co2" type="number" min={0} max={10} step="0.001" value={s.challenges?.kgCo2PerKwh ?? 0.38}
                  onChange={(e) => update({ challenges: { ...s.challenges, kgCo2PerKwh: Number(e.target.value) } })} />
              </Field>
              <Field id="factor-eur" label={t('usecases.admin.eurPerKwh')}>
                <input id="factor-eur" type="number" min={0} max={10} step="0.001" value={s.challenges?.eurPerKwh ?? 0.25}
                  onChange={(e) => update({ challenges: { ...s.challenges, eurPerKwh: Number(e.target.value) } })} />
              </Field>
            </div>
          </fieldset>
          {/* Gamification per challenge (R2-53): points per action; switched per challenge. */}
          <fieldset>
            <legend>{t('insights.admin.points')}</legend>
            <div className="grid grid-3">
              {(['pointsSubmit', 'pointsComment', 'pointsRating'] as const).map((k) => (
                <Field key={k} id={`game-${k}`} label={t(`insights.admin.${k}`)}>
                  <input id={`game-${k}`} type="number" min={0} max={100} step={1} value={s.gamification?.[k] ?? { pointsSubmit: 10, pointsComment: 2, pointsRating: 1 }[k]}
                    onChange={(e) => update({ gamification: { pointsSubmit: 10, pointsComment: 2, pointsRating: 1, ...s.gamification, [k]: Number(e.target.value) } })} />
                </Field>
              ))}
            </div>
          </fieldset>
          {/* Public benchmark (R3-40): only with the consent of the workspace. */}
          <label className="check">
            <input type="checkbox" checked={s.benchmark?.share ?? false} onChange={(e) => update({ benchmark: { share: e.target.checked } })} aria-describedby="benchmark-hint" /> {t('insights.admin.benchmark')}
          </label>
          <p className="small muted" id="benchmark-hint">{t('insights.admin.benchmarkHint')}</p>
          <GuaranteeSettings value={s.guarantee} onChange={(guarantee) => update({ guarantee })} />
          <h2 style={{ marginTop: 20 }}>{t('admin.process.baselines')}</h2>
          <p className="small muted">{t('admin.process.baselinesHint')}</p>
          <div className="grid grid-3">
            {Object.entries(BASELINE_LABELS).map(([k, label]) => (
              <Field key={k} id={`baseline-${k}`} label={label}>
                <input id={`baseline-${k}`} type="number" min={0} step="0.5" value={s.baselines[k as 'gate1'] ?? ''}
                  onChange={(e) => update({ baselines: { ...s.baselines, [k]: e.target.value === '' ? null : Number(e.target.value) } })} />
              </Field>
            ))}
            <Field id="baseline-note" label={t('admin.process.baselineNote')}>
              <input id="baseline-note" type="text" maxLength={300} value={s.baselines.note} onChange={(e) => update({ baselines: { ...s.baselines, note: e.target.value } })} />
            </Field>
          </div>
          <h2 style={{ marginTop: 20 }}>{t('admin.process.retention')}</h2>
          <div className="grid grid-3">
            {Object.entries(RETENTION_LABELS).map(([k, label]) => (
              <Field key={k} id={k} label={label} hint={RETENTION_HINTS[k]}>
                <input id={k} type="number" min={0} value={s.retention[k as keyof Settings['retention']]} aria-describedby={`${k}-hint`}
                  onChange={(e) => update({ retention: { ...s.retention, [k]: Number(e.target.value) } })} />
              </Field>
            ))}
          </div>
        </>
      )}

      {tab === 'elaboration' && <ElaborationSettings s={s} update={update} />}

      {tab === 'topics' && (
        <div className="grid grid-2">
          <Field id="topics" label={t('admin.topics.label')} hint={t('admin.topics.hint')}>
            <textarea id="topics" rows={10} value={topics} onChange={(e) => setTopics(e.target.value)} />
          </Field>
          <Field id="holidays" label={t('admin.holidays.label')} hint={t('admin.holidays.hint')}>
            <textarea id="holidays" rows={10} value={holidays} onChange={(e) => setHolidays(e.target.value)} />
          </Field>
        </div>
      )}

      {tab === 'channels' && (
        <>
          <p>{t('admin.channels.intro')}</p>
          <div className="table-wrap" tabIndex={0}><table>
            <thead><tr><th>{t('admin.channels.id')}</th><th>{t('admin.channels.name')}</th><th>{t('admin.channels.kind')}</th><th>{t('admin.channels.contact')}</th><th>{t('admin.channels.link')}</th><th></th></tr></thead>
            <tbody>
              {s.targetChannels.map((c, i) => {
                const set = (patch: Partial<typeof c>) => update({ targetChannels: s.targetChannels.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
                return (
                  <tr key={i}>
                    <td><input aria-label={t('admin.channels.id')} type="text" value={c.id} onChange={(e) => set({ id: e.target.value })} /></td>
                    <td><input aria-label={t('admin.channels.name')} type="text" value={c.name} onChange={(e) => set({ name: e.target.value })} /></td>
                    <td>
                      <select aria-label={t('admin.channels.kind')} value={c.kind} onChange={(e) => set({ kind: e.target.value })}>
                        {Object.entries(CHANNEL_KINDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                      </select>
                    </td>
                    <td><input aria-label={t('admin.channels.contact')} type="text" value={c.contact} onChange={(e) => set({ contact: e.target.value })} /></td>
                    <td><input aria-label={t('admin.channels.link')} type="text" value={c.url} onChange={(e) => set({ url: e.target.value })} /></td>
                    <td><button type="button" className="danger" onClick={() => update({ targetChannels: s.targetChannels.filter((_, j) => j !== i) })}>{t('admin.remove')}</button></td>
                  </tr>
                );
              })}
            </tbody>
          </table></div>
          <button type="button" onClick={() => update({ targetChannels: [...s.targetChannels, { id: `kanal-${s.targetChannels.length + 1}`, name: '', kind: 'other', contact: '', url: '' }] })}>
            {t('admin.channels.add')}
          </button>
        </>
      )}

      {tab === 'boundary' && (
        <>
          <p>{t('admin.boundary.intro')}</p>
          {s.boundaryRules.map((r, i) => {
            const set = (patch: Partial<typeof r>) => update({ boundaryRules: s.boundaryRules.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
            return (
              <fieldset key={i}>
                <legend>{r.label}</legend>
                <div className="grid grid-3">
                  <Field id={`rl-${i}`} label={t('admin.boundary.label')}><input id={`rl-${i}`} type="text" value={r.label} onChange={(e) => set({ label: e.target.value })} /></Field>
                  <Field id={`rk-${i}`} label={t('admin.boundary.channelKind')}>
                    <select id={`rk-${i}`} value={r.channelKind} onChange={(e) => set({ channelKind: e.target.value })}>
                      {Object.entries(CHANNEL_KINDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                    </select>
                  </Field>
                </div>
                <Field id={`rw-${i}`} label={t('admin.boundary.keywords')} hint={t('admin.boundary.keywordsHint')}>
                  <input id={`rw-${i}`} type="text" value={r.keywords.join(', ')} onChange={(e) => set({ keywords: e.target.value.split(',').map((k) => k.trim()).filter(Boolean) })} />
                </Field>
              </fieldset>
            );
          })}
        </>
      )}

      {tab === 'texts' && (
        <>
          <h2>{t('admin.texts.templates')}</h2>
          {(['fast_lane', 'elaborate', 'forward', 'reject'] as const).map((k) => (
            <Field key={k} id={`t-${k}`} label={LANE_LABELS[k]}>
              <textarea id={`t-${k}`} value={s.texts[k]} onChange={(e) => update({ texts: { ...s.texts, [k]: e.target.value } })} />
            </Field>
          ))}
          <Field id="privacy" label={t('admin.texts.privacy')}>
            <textarea id="privacy" value={s.texts.privacyNotice} onChange={(e) => update({ texts: { ...s.texts, privacyNotice: e.target.value } })} />
          </Field>
          <h2>{t('admin.texts.faq')}</h2>
          {s.texts.faq.map((f, i) => (
            <fieldset key={i}>
              <Field id={`fq-${i}`} label={t('admin.texts.question')}><input id={`fq-${i}`} type="text" value={f.q} onChange={(e) => update({ texts: { ...s.texts, faq: s.texts.faq.map((x, j) => (j === i ? { ...x, q: e.target.value } : x)) } })} /></Field>
              <Field id={`fa-${i}`} label={t('admin.texts.answer')}><textarea id={`fa-${i}`} value={f.a} onChange={(e) => update({ texts: { ...s.texts, faq: s.texts.faq.map((x, j) => (j === i ? { ...x, a: e.target.value } : x)) } })} /></Field>
              <button type="button" className="danger" onClick={() => update({ texts: { ...s.texts, faq: s.texts.faq.filter((_, j) => j !== i) } })}>{t('admin.remove')}</button>
            </fieldset>
          ))}
          <button type="button" onClick={() => update({ texts: { ...s.texts, faq: [...s.texts.faq, { q: '', a: '' }] } })}>{t('admin.texts.addQuestion')}</button>
        </>
      )}

      <div style={{ marginTop: 20 }}>
        <button className="primary" disabled={busy}>{t('admin.saveSettings')}</button>
      </div>
    </form>
  );
}

interface AdminUser {
  id: string;
  email: string;
  displayName: string;
  orgUnit: string | null;
  roles: string[];
  active: boolean;
  mfaEnabled: boolean;
  locked: boolean;
  hasPassword: boolean;
  /** Managed by the identity provider (company login or SCIM, R3-26/R3-27). */
  idpManaged?: boolean;
  /** Roles for one area only (R3-29), managed under Einstellungen › Bereiche. */
  scopedRoles?: ScopedRole[];
}

function Users() {
  const { me } = useSession();
  const isAdmin = hasRole(me, 'admin');
  const { data, error, reload } = useLoad<AdminUser[]>('/api/admin/users');
  // Selection for bulk actions (enterprise).
  const [selected, setSelected] = useState<string[]>([]);
  const toggleSelected = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const areas = useLoad<Area[]>('/api/admin/areas');
  const { busy, error: actionError, run } = useAction();
  const [form, setForm] = useState({ email: '', displayName: '', orgUnit: '', roles: ['submitter'] });
  const [invite, setInvite] = useState<string | null>(null);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    const r = await run(() => api.post<{ id: string; inviteLink?: string }>('/api/admin/users', { ...form, orgUnit: form.orgUnit || null }));
    if (r) {
      setInvite(r.inviteLink ?? t('admin.users.inviteSent'));
      setForm({ email: '', displayName: '', orgUnit: '', roles: ['submitter'] });
      reload();
    }
  };
  const toggleRole = async (u: AdminUser, role: string) => {
    const roles = u.roles.includes(role) ? u.roles.filter((r) => r !== role) : [...u.roles, role];
    if (await run(() => api.patch(`/api/admin/users/${u.id}`, { roles }))) reload();
  };
  const toggleActive = async (u: AdminUser) => {
    if (await run(() => api.patch(`/api/admin/users/${u.id}`, { active: !u.active }))) reload();
  };
  const anonymize = async (u: AdminUser) => {
    if (!window.confirm(t('admin.users.anonymizeConfirm', { name: u.displayName }))) return;
    if (await run(() => api.post(`/api/admin/users/${u.id}/anonymize`))) reload();
  };

  return (
    <div className="stack">
      {isAdmin && <JoinLink />}
      <form className="card" onSubmit={create}>
        <h2>{t('admin.users.inviteTitle')}</h2>
        <ErrorBox error={actionError} />
        {invite && <div className="alert success" role="status">{t('admin.users.invited')} {invite.startsWith('http') ? <>{t('admin.users.inviteLinkShown')} <code style={{ wordBreak: 'break-all' }}>{invite}</code></> : invite}</div>}
        <div className="grid grid-3">
          <Field id="u-name" label={t('admin.users.name')}><input id="u-name" type="text" value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} required /></Field>
          <Field id="u-email" label={t('admin.users.email')}><input id="u-email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required /></Field>
          <Field id="u-org" label={t('admin.users.orgUnit')}><input id="u-org" type="text" value={form.orgUnit} onChange={(e) => setForm({ ...form, orgUnit: e.target.value })} /></Field>
        </div>
        <fieldset>
          <legend>{t('admin.users.roles')}</legend>
          <div className="row">
            {Object.entries(ROLES).map(([k, v]) => (
              <label key={k} className="check">
                <input type="checkbox" checked={form.roles.includes(k)} disabled={k === 'submitter' || (k === 'admin' && !isAdmin)} onChange={(e) => setForm({ ...form, roles: e.target.checked ? [...form.roles, k] : form.roles.filter((r) => r !== k) })} /> {v}
              </label>
            ))}
          </div>
        </fieldset>
        <button className="primary" disabled={busy}>{t('admin.users.invite')}</button>
      </form>
      <PeopleImport onDone={() => void reload()} />
      {selected.length > 0 && <BulkBar selected={selected} onDone={() => { setSelected([]); void reload(); }} />}
      <section className="card">
        <h2>{t('admin.users.title')}</h2>
        <ErrorBox error={error} />
        <div style={{ overflowX: 'auto' }}>
          <div className="table-wrap" tabIndex={0}><table>
            <thead>
              <tr>
                <th scope="col">
                  <input
                    type="checkbox"
                    aria-label={t('ent.bulk.selectAll')}
                    checked={!!data?.length && selected.length === data.filter((u) => u.id !== me.user.id).length}
                    onChange={(e) => setSelected(e.target.checked ? (data ?? []).filter((u) => u.id !== me.user.id).map((u) => u.id) : [])}
                  />
                </th>
                <th>{t('admin.users.person')}</th>{Object.entries(ROLES).filter(([k]) => k !== 'submitter').map(([k, v]) => <th key={k}>{v}</th>)}<th>{t('admin.users.status')}</th>
              </tr>
            </thead>
            <tbody>
              {data?.map((u) => (
                <tr key={u.id}>
                  <td>
                    {u.id !== me.user.id && (
                      <input type="checkbox" aria-label={t('ent.bulk.selectPerson', { name: u.displayName })} checked={selected.includes(u.id)} onChange={() => toggleSelected(u.id)} />
                    )}
                  </td>
                  <td>
                    <strong>{u.displayName}</strong>
                    <div className="small muted">{u.email}{u.orgUnit ? ` · ${u.orgUnit}` : ''}</div>
                    {!!u.scopedRoles?.length && (
                      <div className="small">
                        {u.scopedRoles.map((r) => t('areas.scoped', { role: ROLES[r.role], area: areas.data?.find((a) => a.id === r.areaId)?.name ?? '…' })).join(' · ')}
                      </div>
                    )}
                  </td>
                  {Object.keys(ROLES).filter((k) => k !== 'submitter').map((k) => (
                    <td key={k}>
                      <input
                        type="checkbox"
                        aria-label={t('admin.users.roleFor', { role: ROLES[k], name: u.displayName })}
                        checked={u.roles.includes(k)}
                        disabled={busy || (u.id === me.user.id && k === 'admin') || (!isAdmin && (k === 'admin' || u.roles.includes('admin')))}
                        onChange={() => toggleRole(u, k)}
                      />
                    </td>
                  ))}
                  <td className="small">
                    {u.idpManaged ? <span className="badge">{t('identity.badge.sso')}</span> : !u.hasPassword && <span className="badge yellow">{t('admin.users.badgeInvited')}</span>} {u.locked && <span className="badge red">{t('admin.users.badgeLocked')}</span>}{' '}
                    {u.mfaEnabled && <span className="badge green">{t('admin.users.badgeMfa')}</span>}{' '}
                    {u.id !== me.user.id && (isAdmin || !u.roles.includes('admin')) && <button type="button" className="link" onClick={() => toggleActive(u)}>{u.active ? t('admin.users.deactivate') : t('admin.users.activate')}</button>}{' '}
                    {isAdmin && <a href={`/api/admin/users/${u.id}/export`} download="auskunft.json" aria-label={t('admin.users.exportFor', { name: u.displayName })}>{t('admin.users.export')}</a>}{' '}
                    {isAdmin && u.id !== me.user.id && (
                      <button type="button" className="link" onClick={() => anonymize(u)} aria-label={t('admin.users.anonymizeFor', { name: u.displayName })}>{t('admin.users.anonymize')}</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table></div>
        </div>
      </section>
    </div>
  );
}

function DataTab() {
  const { busy, error, run } = useAction();
  const [result, setResult] = useState<string | null>(null);
  return (
    <section className="card stack">
      <TenantExport />
      <h2>{t('admin.data.jobsTitle')}</h2>
      <p>{t('admin.data.jobsText')}</p>
      <ErrorBox error={error} />
      {result && <pre className="small">{result}</pre>}
      <div>
        <button disabled={busy} onClick={async () => { const r = await run(() => api.post('/api/admin/jobs/run')); if (r) setResult(JSON.stringify(r, null, 2)); }}>
          {t('admin.data.jobsButton')}
        </button>
      </div>
      <Offboarding />
    </section>
  );
}

function JoinLink() {
  const { data, reload } = useLoad<{ code: string | null }>('/api/admin/join-link');
  const { busy, error, run } = useAction();
  const [copied, setCopied] = useState(false);
  const link = data?.code ? `${window.location.origin}/beitreten/${data.code}` : null;
  const set = async (enabled: boolean) => {
    setCopied(false);
    if (await run(() => api.post('/api/admin/join-link', { enabled }))) await reload();
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link!);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <section className="card" aria-labelledby="h-join">
      <h2 id="h-join">{t('admin.join.title')}</h2>
      <p className="small muted">{t('admin.join.hint')}</p>
      <ErrorBox error={error} />
      {!data ? <Loading /> : link ? (
        <>
          <div className="row">
            <input type="text" readOnly value={link} aria-label={t('admin.join.title')} onFocus={(e) => e.target.select()} style={{ flex: 1, minWidth: 220 }} />
            <button type="button" onClick={copy}>{copied ? t('admin.join.copied') : t('admin.join.copy')}</button>
          </div>
          <div className="row" style={{ marginTop: 8 }}>
            <button type="button" disabled={busy} onClick={() => set(true)}>{t('admin.join.renew')}</button>
            <button type="button" className="danger" disabled={busy} onClick={() => set(false)}>{t('admin.join.disable')}</button>
          </div>
        </>
      ) : (
        <button type="button" className="primary" disabled={busy} onClick={() => set(true)}>{t('admin.join.create')}</button>
      )}
    </section>
  );
}

interface ImportResult {
  headers: string[];
  mapping: Partial<Record<ImportField, number>>;
  preview: Record<string, string>[];
  report: { total: number; imported: number; duplicates: number[]; skipped: number[]; unknownAuthors: number };
  dryRun: boolean;
}

type ImportField = 'title' | 'problem' | 'solution' | 'benefit' | 'topic' | 'email';
const IMPORT_FIELD_KEYS: ImportField[] = ['title', 'problem', 'solution', 'benefit', 'topic', 'email'];
const IMPORT_FIELDS = labelMap('admin.importField', IMPORT_FIELD_KEYS);

function Import() {
  const [file, setFile] = useState<{ name: string; data: string } | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [mapping, setMapping] = useState<Partial<Record<ImportField, number>>>({});
  const [done, setDone] = useState<ImportResult | null>(null);
  const { busy, error, run } = useAction();
  // Without a recognizable title column the server answers with the headers so they can be mapped by hand.
  const unmapped = error?.details as { headers?: string[]; mapping?: ImportResult['mapping'] } | undefined;
  useEffect(() => {
    if (unmapped?.headers && !result) {
      setResult({ headers: unmapped.headers, mapping: unmapped.mapping ?? {}, preview: [], report: { total: 0, imported: 0, duplicates: [], skipped: [], unknownAuthors: 0 }, dryRun: true });
      setMapping(unmapped.mapping ?? {});
    }
  }, [unmapped, result]);

  const choose = async (f: File | undefined) => {
    setResult(null);
    setDone(null);
    if (!f) return setFile(null);
    const data = await readBase64(f);
    setFile({ name: f.name, data });
    const r = await run(() => api.post<ImportResult>('/api/admin/import', { filename: f.name, data, dryRun: true }));
    if (r) {
      setResult(r);
      setMapping(r.mapping);
    }
  };
  const preview = async () => {
    const r = await run(() => api.post<ImportResult>('/api/admin/import', { filename: file!.name, data: file!.data, mapping, dryRun: true }));
    if (r) setResult(r);
  };
  const runImport = async () => {
    const r = await run(() => api.post<ImportResult>('/api/admin/import', { filename: file!.name, data: file!.data, mapping, dryRun: false }));
    if (r) {
      setDone(r);
      setResult(null);
    }
  };

  return (
    <section className="card stack" aria-labelledby="h-import">
      <h2 id="h-import">{t('admin.import.title')}</h2>
      <p>{t('admin.import.intro')}</p>
      <ErrorBox error={error} />
      {done && (
        <div className="alert success" role="status">
          {t('admin.import.doneImported', { n: done.report.imported })} {done.report.duplicates.length > 0 && t('admin.import.doneDuplicates', { n: done.report.duplicates.length })}
          {done.report.skipped.length > 0 && t('admin.import.doneSkipped', { n: done.report.skipped.length })}
        </div>
      )}
      <Field id="import-file" label={t('admin.import.file')} hint={t('admin.import.fileHint')}>
        <input id="import-file" type="file" accept=".csv,.txt,.xlsx" onChange={(e) => choose(e.target.files?.[0])} disabled={busy} aria-describedby="import-file-hint" />
      </Field>
      {result && (
        <>
          <fieldset>
            <legend>{t('admin.import.mapColumns')}</legend>
            <div className="grid grid-3">
              {IMPORT_FIELD_KEYS.map((f) => (
                <Field key={f} id={`map-${f}`} label={IMPORT_FIELDS[f]}>
                  <select id={`map-${f}`} value={mapping[f] ?? ''} onChange={(e) => setMapping({ ...mapping, [f]: e.target.value === '' ? undefined : Number(e.target.value) })}>
                    <option value="">{t('admin.import.skipColumn')}</option>
                    {result.headers.map((h, i) => <option key={i} value={i}>{h || t('admin.import.column', { n: i + 1 })}</option>)}
                  </select>
                </Field>
              ))}
            </div>
            <button type="button" onClick={preview} disabled={busy}>{t('admin.import.refreshPreview')}</button>
          </fieldset>
          <p>
            <strong>{result.report.imported}</strong> {t('admin.import.ofRows', { total: result.report.total })}
            {result.report.duplicates.length > 0 && ` ${t('admin.import.duplicates', { rows: result.report.duplicates.slice(0, 10).join(', ') })}`}
            {result.report.skipped.length > 0 && ` ${t('admin.import.skipped', { rows: result.report.skipped.slice(0, 10).join(', ') })}`}
            {result.report.unknownAuthors > 0 && ` ${t('admin.import.unknownAuthors', { n: result.report.unknownAuthors })}`}
          </p>
          {result.preview.length > 0 && (
            <div style={{ overflowX: 'auto' }}>
              <div className="table-wrap" tabIndex={0}><table>
                <caption className="sr-only">{t('admin.import.previewCaption')}</caption>
                <thead><tr><th>{t('admin.import.colTitle')}</th><th>{t('admin.import.colProblem')}</th><th>{t('admin.import.colTopic')}</th><th>{t('admin.import.colAuthor')}</th></tr></thead>
                <tbody>
                  {result.preview.map((p, i) => (
                    <tr key={i}><td>{p.title}</td><td className="small">{p.problem}</td><td>{p.topic || '–'}</td><td className="small">{p.author || '–'}</td></tr>
                  ))}
                </tbody>
              </table></div>
            </div>
          )}
          <div>
            <button type="button" className="primary" onClick={runImport} disabled={busy || result.report.imported === 0}>
              {t('admin.import.run', { n: result.report.imported })}
            </button>
          </div>
        </>
      )}
    </section>
  );
}

function ElaborationSettings({ s, update }: { s: Settings; update: (patch: Partial<Settings>) => void }) {
  const criteria = s.scorecard.criteria;
  const sum = criteria.reduce((n, c) => n + (Number(c.weight) || 0), 0);
  const setCriterion = (i: number, patch: Partial<Criterion>) =>
    update({ scorecard: { criteria: criteria.map((c, j) => (j === i ? { ...c, ...patch } : c)) } });
  const add = () =>
    update({ scorecard: { criteria: [...criteria, { id: `kriterium_${criteria.length + 1}`, label: t('admin.scorecard.newCriterion'), question: '', weight: 0, anchors: { 1: '', 3: '', 5: '' } }] } });
  const remove = (i: number) => update({ scorecard: { criteria: criteria.filter((_, j) => j !== i) } });
  return (
    <>
      <h2>{t('admin.elab.title')}</h2>
      <div className="grid grid-3">
        {Object.entries(ELABORATION_LABELS).map(([k, label]) => {
          const hint = ELABORATION_HINTS[k]?.();
          return (
          <Field key={k} id={`el-${k}`} label={label} hint={hint}>
            <input id={`el-${k}`} type="number" min={0} value={s.elaboration[k]} aria-describedby={hint ? `el-${k}-hint` : undefined}
              onChange={(e) => update({ elaboration: { ...s.elaboration, [k]: Number(e.target.value) } })} />
          </Field>
          );
        })}
      </div>
      <p className="hint">{t('admin.elab.delegationHint')}</p>
      <h2 style={{ marginTop: 20 }}>{t('admin.scorecard.title')}</h2>
      <p className="small muted">{t('admin.scorecard.hint')}</p>
      <p className={Math.abs(sum - 100) < 0.01 ? 'small' : 'alert warn small'} role="status">{t('admin.scorecard.sum', { sum })}</p>
      {criteria.map((c, i) => (
        <fieldset key={i} className="card" style={{ marginBottom: 12 }}>
          <legend>{t('admin.scorecard.legend', { n: i + 1, label: c.label })}</legend>
          <div className="grid grid-3">
            <Field id={`sc-label-${i}`} label={t('admin.scorecard.label')}>
              <input id={`sc-label-${i}`} type="text" value={c.label} onChange={(e) => setCriterion(i, { label: e.target.value })} />
            </Field>
            <Field id={`sc-id-${i}`} label={t('admin.scorecard.id')} hint={t('admin.scorecard.idHint')}>
              <input id={`sc-id-${i}`} type="text" value={c.id} onChange={(e) => setCriterion(i, { id: e.target.value })} aria-describedby={`sc-id-${i}-hint`} />
            </Field>
            <Field id={`sc-weight-${i}`} label={t('admin.scorecard.weight')}>
              <input id={`sc-weight-${i}`} type="number" min={0} max={100} value={c.weight} onChange={(e) => setCriterion(i, { weight: Number(e.target.value) })} />
            </Field>
          </div>
          <Field id={`sc-q-${i}`} label={t('admin.scorecard.question')}>
            <input id={`sc-q-${i}`} type="text" value={c.question} onChange={(e) => setCriterion(i, { question: e.target.value })} />
          </Field>
          <div className="grid grid-3">
            {([1, 3, 5] as const).map((n) => (
              <Field key={n} id={`sc-a${n}-${i}`} label={t('admin.scorecard.anchor', { n })}>
                <textarea id={`sc-a${n}-${i}`} rows={2} value={c.anchors[n]} onChange={(e) => setCriterion(i, { anchors: { ...c.anchors, [n]: e.target.value } })} />
              </Field>
            ))}
          </div>
          <button type="button" className="link" onClick={() => remove(i)} disabled={criteria.length <= 1}>{t('admin.scorecard.remove')}</button>
        </fieldset>
      ))}
      <button type="button" onClick={add} disabled={criteria.length >= 12}>{t('admin.scorecard.add')}</button>
    </>
  );
}
