import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../api';
import { ErrorBox, Field, Loading, useAction, useLoad } from '../components';
import { formatDateTime } from '../labels';
import { t } from '../i18n';

// Co-determination overview (R3-12) for the works council and data protection: roles and
// rights, reports, AI functions, retention periods, logs and change history, all built by the
// server from the code and the settings. Admins switch AI functions and fill in the details for
// the generated agreements; the works council reads and downloads only.

interface AgreementSettings {
  employer: string;
  worksCouncil: string;
  scope: string;
  objectionBody: string;
  objectionWeeks: number;
  announceWeeks: number;
  pilotArea: string;
  pilotMonths: number;
}

interface AiFunction {
  agent: string;
  label: string;
  story: string;
  switchedOn: boolean;
  active: boolean;
  ideaTypes: Partial<Record<'internal' | 'product', boolean>> | null;
  model: { provider: string; model: string; hosting: string } | { error: string };
  data: string;
  webSearch: boolean;
}

interface Overview {
  canEdit: boolean;
  minGroupSize: number;
  roles: { role: string; label: string; permissions: { key: string; label: string }[]; endpoints: string[] }[];
  relations: string[];
  /** Roles with an area (R3-29). */
  scopedRoles?: {
    roles: { role: string; label: string }[];
    areas: { id: string; name: string; topics: string[]; orgUnits: string[]; roles: { role: string; people: number }[] }[];
  };
  endpoints: { total: number; restricted: number; signedIn: number };
  reports: { key: string; label: string; purpose: string; endpoint: string; aggregationText: string; roleLabels: string[] }[];
  ai: {
    enabled: boolean;
    functions: AiFunction[];
    confidential: { provider: string; model: string; hosting: string } | { error: string };
    search: { label: string; internalShort: boolean; productShort: boolean };
    budget: { perIdeaEur: number; perMonthEur: number };
  };
  retention: {
    periods: { key: string; label: string; text: string }[];
    protocols: { key: string; label: string; content: string; retention: string }[];
  };
  history: { id: string; createdAt: string; actorName: string | null; label: string; changes: { path: string; before: string; after: string }[] }[];
  agreement: { settings: AgreementSettings; templates: { name: string; title: string; version: string }[] };
}

export function Codetermination() {
  const { data, error, loading, reload } = useLoad<Overview>('/api/codetermination');
  if (loading && !data) return <Loading />;
  if (!data) return <ErrorBox error={error} />;
  return (
    <div className="stack">
      <h1>{t('codetermination.title')}</h1>
      <p className="muted">{t('codetermination.intro', { n: data.minGroupSize })}</p>
      <ErrorBox error={error} />
      <Agreements data={data} onSaved={reload} />
      <AiFunctions data={data} onChanged={reload} />
      <Roles data={data} />
      <Reports data={data} />
      <Retention data={data} />
      <History data={data} />
    </div>
  );
}

function Agreements({ data, onSaved }: { data: Overview; onSaved: () => void }) {
  const [form, setForm] = useState<AgreementSettings>(data.agreement.settings);
  const { busy, error, run } = useAction();
  const [saved, setSaved] = useState(false);
  useEffect(() => setForm(data.agreement.settings), [data.agreement.settings]);
  const text = (k: keyof AgreementSettings, label: string) => (
    <Field id={`ag-${k}`} label={label}>
      <input id={`ag-${k}`} type="text" value={form[k] as string} disabled={!data.canEdit} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
    </Field>
  );
  const num = (k: keyof AgreementSettings, label: string, min: number, max: number) => (
    <Field id={`ag-${k}`} label={label}>
      <input id={`ag-${k}`} type="number" min={min} max={max} value={form[k] as number} disabled={!data.canEdit} onChange={(e) => setForm({ ...form, [k]: Number(e.target.value) })} />
    </Field>
  );
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setSaved(false);
    if (await run(() => api.put('/api/codetermination/agreement-settings', form))) {
      setSaved(true);
      onSaved();
    }
  };
  return (
    <section className="card" aria-labelledby="cd-agreements">
      <h2 id="cd-agreements">{t('codetermination.agreements.title')}</h2>
      <div className="alert" role="note">{t('codetermination.agreements.disclaimer')}</div>
      <ul>
        {data.agreement.templates.map((tpl) => (
          <li key={tpl.name}>
            <strong>{tpl.title}</strong> ({t('codetermination.agreements.version', { version: tpl.version })}):{' '}
            <a href={`/api/codetermination/agreements/${tpl.name}?format=pdf`} download>{t('codetermination.agreements.pdf')}</a>{' · '}
            <a href={`/api/codetermination/agreements/${tpl.name}?format=md`} download>{t('codetermination.agreements.md')}</a>
          </li>
        ))}
      </ul>
      <form onSubmit={save}>
        <h3>{t('codetermination.agreements.details')}</h3>
        <p className="small muted">{t(data.canEdit ? 'codetermination.agreements.detailsHint' : 'codetermination.readOnly')}</p>
        <div className="grid grid-2">
          {text('employer', t('codetermination.agreements.employer'))}
          {text('worksCouncil', t('codetermination.agreements.worksCouncil'))}
          {text('scope', t('codetermination.agreements.scope'))}
          {text('objectionBody', t('codetermination.agreements.objectionBody'))}
        </div>
        <div className="grid grid-3">
          {num('objectionWeeks', t('codetermination.agreements.objectionWeeks'), 1, 12)}
          {num('announceWeeks', t('codetermination.agreements.announceWeeks'), 0, 26)}
          {num('pilotMonths', t('codetermination.agreements.pilotMonths'), 1, 12)}
        </div>
        {text('pilotArea', t('codetermination.agreements.pilotArea'))}
        <ErrorBox error={error} />
        {data.canEdit && (
          <p>
            <button type="submit" className="primary" disabled={busy}>{t('codetermination.agreements.save')}</button>{' '}
            {saved && <span role="status" className="small muted">{t('codetermination.agreements.saved')}</span>}
          </p>
        )}
      </form>
    </section>
  );
}

function AiFunctions({ data, onChanged }: { data: Overview; onChanged: () => void }) {
  const { busy, error, run } = useAction();
  const toggle = async (f: AiFunction, enabled: boolean) => {
    if (await run(() => api.put(`/api/codetermination/ai-functions/${f.agent}`, { enabled }))) onChanged();
  };
  const conf = data.ai.confidential;
  return (
    <section className="card" aria-labelledby="cd-ai">
      <h2 id="cd-ai">{t('codetermination.ai.title')}</h2>
      {!data.ai.enabled && <div className="alert" role="note">{t('codetermination.ai.allOff')}</div>}
      <p className="small muted">{t(data.canEdit ? 'codetermination.ai.hintAdmin' : 'codetermination.ai.hintReader')}</p>
      <ul className="small">
        <li>{t('codetermination.ai.confidential', { value: 'error' in conf ? conf.error : `${conf.provider}, ${conf.model} (${conf.hosting})` })}</li>
        <li>{t('codetermination.ai.search', { value: data.ai.search.label })} {t(data.ai.search.internalShort ? 'codetermination.ai.internalSearchOn' : 'codetermination.ai.internalSearchOff')}</li>
        <li>{t('codetermination.ai.budget', { idea: data.ai.budget.perIdeaEur, month: data.ai.budget.perMonthEur })}</li>
      </ul>
      <ErrorBox error={error} />
      <div className="table-wrap" tabIndex={0}><table>
        <caption className="sr-only">{t('codetermination.ai.caption')}</caption>
        <thead><tr>
          <th scope="col">{t('codetermination.ai.function')}</th>
          <th scope="col">{t('codetermination.ai.state')}</th>
          <th scope="col">{t('codetermination.ai.provider')}</th>
          <th scope="col">{t('codetermination.ai.hosting')}</th>
          <th scope="col">{t('codetermination.ai.data')}</th>
          <th scope="col">{t('codetermination.ai.webSearch')}</th>
        </tr></thead>
        <tbody>
          {data.ai.functions.map((f) => (
            <tr key={f.agent}>
              <th scope="row">{f.label} <span className="small muted">{f.story}</span></th>
              <td>
                {data.canEdit ? (
                  <label className="check">
                    <input type="checkbox" checked={f.switchedOn} disabled={busy} onChange={(e) => toggle(f, e.target.checked)} />{' '}
                    {t(f.switchedOn ? 'codetermination.ai.on' : 'codetermination.ai.off')}
                  </label>
                ) : (
                  <span className={`badge ${f.active ? 'green' : ''}`}>{t(f.active ? 'codetermination.ai.active' : 'codetermination.ai.inactive')}</span>
                )}
                {f.switchedOn && !f.active && <div className="small muted">{t(data.ai.enabled ? 'codetermination.ai.offByType' : 'codetermination.ai.offGlobal')}</div>}
                {f.ideaTypes && <div className="small muted">{Object.entries(f.ideaTypes).map(([type, on]) => t(on ? 'codetermination.ai.typeOn' : 'codetermination.ai.typeOff', { type: t(`codetermination.ai.type.${type}` as 'codetermination.ai.type.internal') })).join(' · ')}</div>}
              </td>
              <td>{'error' in f.model ? f.model.error : `${f.model.provider}, ${f.model.model}`}</td>
              <td>{'error' in f.model ? '' : f.model.hosting}</td>
              <td className="small">{f.data}</td>
              <td>{t(f.webSearch ? 'codetermination.yes' : 'codetermination.no')}</td>
            </tr>
          ))}
        </tbody>
      </table></div>
    </section>
  );
}

function Roles({ data }: { data: Overview }) {
  return (
    <section className="card" aria-labelledby="cd-roles">
      <h2 id="cd-roles">{t('codetermination.roles.title')}</h2>
      <p className="small muted">{t('codetermination.roles.intro', { restricted: data.endpoints.restricted, signedIn: data.endpoints.signedIn })}</p>
      <div className="table-wrap" tabIndex={0}><table>
        <caption className="sr-only">{t('codetermination.roles.caption')}</caption>
        <thead><tr><th scope="col">{t('codetermination.roles.role')}</th><th scope="col">{t('codetermination.roles.rights')}</th><th scope="col">{t('codetermination.roles.endpoints')}</th></tr></thead>
        <tbody>
          {data.roles.map((r) => (
            <tr key={r.role}>
              <th scope="row">{r.label}</th>
              <td>{r.permissions.length ? <ul className="small">{r.permissions.map((p) => <li key={p.key}>{p.label}</li>)}</ul> : <span className="small muted">{t('codetermination.roles.none')}</span>}</td>
              <td>
                {r.endpoints.length ? (
                  <details>
                    <summary>{t('codetermination.roles.endpointCount', { n: r.endpoints.length })}</summary>
                    <ul className="small">{r.endpoints.map((e) => <li key={e}><code>{e}</code></li>)}</ul>
                  </details>
                ) : '0'}
              </td>
            </tr>
          ))}
        </tbody>
      </table></div>
      <h3>{t('codetermination.roles.relations')}</h3>
      <ul className="small">{data.relations.map((r) => <li key={r}>{r}</li>)}</ul>
      {data.scopedRoles && (
        <>
          <h3>{t('areas.codet.title')}</h3>
          <p className="small muted">{t('areas.codet.intro')}</p>
          {data.scopedRoles.areas.length === 0 ? <p className="small">{t('areas.codet.empty')}</p> : (
            <div className="table-wrap" tabIndex={0}><table>
              <caption className="sr-only">{t('areas.codet.title')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('areas.roles.area')}</th>
                  <th scope="col">{t('areas.rule')}</th>
                  {data.scopedRoles.roles.map((r) => <th key={r.role} scope="col">{r.label}</th>)}
                </tr>
              </thead>
              <tbody>
                {data.scopedRoles.areas.map((a) => (
                  <tr key={a.id}>
                    <th scope="row">{a.name}</th>
                    <td className="small">
                      <div>{t('areas.topics')}: {a.topics.join(', ') || t('areas.none')}</div>
                      <div>{t('areas.orgUnits')}: {a.orgUnits.join(', ') || t('areas.none')}</div>
                    </td>
                    {data.scopedRoles!.roles.map((r) => (
                      <td key={r.role}>{t('areas.codet.people', { n: a.roles.find((x) => x.role === r.role)?.people ?? 0 })}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table></div>
          )}
        </>
      )}
    </section>
  );
}

function Reports({ data }: { data: Overview }) {
  return (
    <section className="card" aria-labelledby="cd-reports">
      <h2 id="cd-reports">{t('codetermination.reports.title')}</h2>
      <div className="table-wrap" tabIndex={0}><table>
        <caption className="sr-only">{t('codetermination.reports.caption')}</caption>
        <thead><tr><th scope="col">{t('codetermination.reports.report')}</th><th scope="col">{t('codetermination.reports.purpose')}</th><th scope="col">{t('codetermination.reports.aggregation')}</th><th scope="col">{t('codetermination.reports.roles')}</th></tr></thead>
        <tbody>
          {data.reports.map((r) => (
            <tr key={r.key}>
              <th scope="row">{r.label}<div className="small muted"><code>{r.endpoint}</code></div></th>
              <td className="small">{r.purpose}</td>
              <td>{r.aggregationText}</td>
              <td>{r.roleLabels.join(', ')}</td>
            </tr>
          ))}
        </tbody>
      </table></div>
    </section>
  );
}

function Retention({ data }: { data: Overview }) {
  return (
    <section className="card" aria-labelledby="cd-retention">
      <h2 id="cd-retention">{t('codetermination.retention.title')}</h2>
      <div className="table-wrap" tabIndex={0}><table>
        <caption className="sr-only">{t('codetermination.retention.caption')}</caption>
        <thead><tr><th scope="col">{t('codetermination.retention.data')}</th><th scope="col">{t('codetermination.retention.period')}</th></tr></thead>
        <tbody>{data.retention.periods.map((p) => <tr key={p.key}><th scope="row">{p.label}</th><td>{p.text}</td></tr>)}</tbody>
      </table></div>
      <h3>{t('codetermination.protocols.title')}</h3>
      <div className="table-wrap" tabIndex={0}><table>
        <caption className="sr-only">{t('codetermination.protocols.caption')}</caption>
        <thead><tr><th scope="col">{t('codetermination.protocols.protocol')}</th><th scope="col">{t('codetermination.protocols.content')}</th><th scope="col">{t('codetermination.retention.period')}</th></tr></thead>
        <tbody>{data.retention.protocols.map((p) => <tr key={p.key}><th scope="row">{p.label}</th><td className="small">{p.content}</td><td>{p.retention}</td></tr>)}</tbody>
      </table></div>
    </section>
  );
}

function History({ data }: { data: Overview }) {
  return (
    <section className="card" aria-labelledby="cd-history">
      <h2 id="cd-history">{t('codetermination.history.title')}</h2>
      <p className="small muted">{t('codetermination.history.intro')}</p>
      {data.history.length === 0 ? <p className="muted">{t('codetermination.history.empty')}</p> : (
        <div className="table-wrap" tabIndex={0}><table>
          <caption className="sr-only">{t('codetermination.history.caption')}</caption>
          <thead><tr><th scope="col">{t('codetermination.history.when')}</th><th scope="col">{t('codetermination.history.who')}</th><th scope="col">{t('codetermination.history.what')}</th><th scope="col">{t('codetermination.history.changes')}</th></tr></thead>
          <tbody>
            {data.history.map((h) => (
              <tr key={h.id}>
                <td>{formatDateTime(h.createdAt)}</td>
                <td>{h.actorName ?? t('codetermination.history.system')}</td>
                <th scope="row">{h.label}</th>
                <td className="small">
                  {h.changes.length === 0 ? t('codetermination.history.noChange') : (
                    <ul>{h.changes.map((c) => <li key={c.path}><code>{c.path}</code>: {c.before} → {c.after}</li>)}</ul>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
    </section>
  );
}
