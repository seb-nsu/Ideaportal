import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { ErrorBox, Field, Loading, useAction, useLoad } from '../components';
import { ROLES } from '../labels';
import { t } from '../i18n';

// Einstellungen › Bereiche (R3-29): areas as master data and roles that apply to one area only.

export interface Area {
  id: string;
  name: string;
  description: string;
  topics: string[];
  orgUnits: string[];
}

export interface ScopedRole {
  role: string;
  areaId: string;
  source?: string;
}

interface Person {
  id: string;
  displayName: string;
  email: string;
  active: boolean;
  scopedRoles: ScopedRole[];
}

export const SCOPABLE_ROLES = ['triage', 'committee', 'lead'] as const;

const EMPTY = { name: '', description: '', topics: [] as string[], orgUnits: '' };

export function AreasAdmin() {
  const areas = useLoad<Area[]>('/api/admin/areas');
  const settings = useLoad<{ topics: string[] }>('/api/admin/settings');
  const people = useLoad<Person[]>('/api/admin/users');
  const { busy, error, run } = useAction();
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [form, setForm] = useState(EMPTY);
  const [assign, setAssign] = useState({ userId: '', role: 'triage', areaId: '' });

  if ((areas.loading && !areas.data) || (people.loading && !people.data)) return <Loading />;
  const list = areas.data ?? [];
  const areaName = (id: string) => list.find((a) => a.id === id)?.name ?? id;
  const topics = settings.data?.topics ?? [];

  const startEdit = (a: Area | null) => {
    setEditing(a ? a.id : 'new');
    setForm(a ? { name: a.name, description: a.description, topics: a.topics, orgUnits: a.orgUnits.join('\n') } : EMPTY);
  };
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const body = { ...form, orgUnits: form.orgUnits.split('\n').map((x) => x.trim()).filter(Boolean) };
    const ok = await run(() => (editing === 'new' ? api.post('/api/admin/areas', body) : api.put(`/api/admin/areas/${editing}`, body)));
    if (ok) {
      setEditing(null);
      areas.reload();
    }
  };
  const remove = async (a: Area) => {
    if (!window.confirm(t('areas.deleteConfirm', { name: a.name }))) return;
    if (await run(() => api.del(`/api/admin/areas/${a.id}`))) {
      areas.reload();
      people.reload();
    }
  };
  // The API replaces the manually given scoped roles of a person; roles from groups stay.
  const manual = (p: Person) => p.scopedRoles.filter((r) => r.source !== 'idp').map(({ role, areaId }) => ({ role, areaId }));
  const setRoles = async (p: Person, scopedRoles: ScopedRole[]) => {
    if (await run(() => api.patch(`/api/admin/users/${p.id}`, { scopedRoles }))) people.reload();
  };
  const addRole = async (e: FormEvent) => {
    e.preventDefault();
    const p = people.data?.find((x) => x.id === assign.userId);
    if (!p || !assign.areaId) return;
    await setRoles(p, [...manual(p), { role: assign.role, areaId: assign.areaId }]);
  };
  const holders = (people.data ?? []).filter((p) => p.scopedRoles.length > 0);

  return (
    <div className="stack">
      <section className="card stack" aria-labelledby="h-areas">
        <div className="row spread">
          <h2 id="h-areas">{t('areas.title')}</h2>
          <button type="button" onClick={() => startEdit(null)} disabled={busy}>{t('areas.create')}</button>
        </div>
        <p className="small muted">{t('areas.intro')}</p>
        <ErrorBox error={areas.error ?? error} />
        {list.length === 0 ? <p>{t('areas.empty')}</p> : (
          <div className="table-wrap" tabIndex={0}><table>
            <thead><tr><th>{t('areas.name')}</th><th>{t('areas.rule')}</th><th /></tr></thead>
            <tbody>
              {list.map((a) => (
                <tr key={a.id}>
                  <td><strong>{a.name}</strong>{a.description && <div className="small muted">{a.description}</div>}</td>
                  <td className="small">
                    <div>{t('areas.topics')}: {a.topics.join(', ') || t('areas.none')}</div>
                    <div>{t('areas.orgUnits')}: {a.orgUnits.join(', ') || t('areas.none')}</div>
                  </td>
                  <td>
                    <button type="button" className="link" onClick={() => startEdit(a)} aria-label={t('areas.editFor', { name: a.name })}>{t('areas.edit')}</button>{' '}
                    <button type="button" className="link" onClick={() => remove(a)} aria-label={t('areas.deleteFor', { name: a.name })}>{t('areas.delete')}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
        {editing && (
          <form className="stack" onSubmit={save} aria-labelledby="h-area-form">
            <h3 id="h-area-form">{editing === 'new' ? t('areas.newTitle') : t('areas.editTitle')}</h3>
            <Field id="area-name" label={t('areas.name')}>
              <input id="area-name" type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required minLength={2} maxLength={80} />
            </Field>
            <Field id="area-desc" label={t('areas.description')}>
              <input id="area-desc" type="text" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} maxLength={500} />
            </Field>
            <fieldset>
              <legend>{t('areas.topics')}</legend>
              <p className="hint">{t('areas.topicsHint')}</p>
              <div className="row">
                {[...new Set([...topics, ...form.topics])].map((tp) => (
                  <label key={tp} className="check">
                    <input type="checkbox" checked={form.topics.includes(tp)}
                      onChange={(e) => setForm({ ...form, topics: e.target.checked ? [...form.topics, tp] : form.topics.filter((x) => x !== tp) })} /> {tp}
                  </label>
                ))}
              </div>
            </fieldset>
            <Field id="area-units" label={t('areas.orgUnits')} hint={t('areas.orgUnitsHint')}>
              <textarea id="area-units" rows={3} value={form.orgUnits} onChange={(e) => setForm({ ...form, orgUnits: e.target.value })} aria-describedby="area-units-hint" />
            </Field>
            <div className="row">
              <button className="primary" disabled={busy}>{t('areas.save')}</button>
              <button type="button" onClick={() => setEditing(null)}>{t('areas.cancel')}</button>
            </div>
          </form>
        )}
      </section>

      <section className="card stack" aria-labelledby="h-area-roles">
        <h2 id="h-area-roles">{t('areas.roles.title')}</h2>
        <p className="small muted">{t('areas.roles.intro')}</p>
        <ErrorBox error={people.error} />
        {list.length === 0 ? <p>{t('areas.roles.needArea')}</p> : (
          <form className="grid grid-3" onSubmit={addRole}>
            <Field id="ar-person" label={t('areas.roles.person')}>
              <select id="ar-person" value={assign.userId} onChange={(e) => setAssign({ ...assign, userId: e.target.value })} required>
                <option value="">{t('areas.roles.choose')}</option>
                {people.data?.filter((p) => p.active).map((p) => <option key={p.id} value={p.id}>{p.displayName} ({p.email})</option>)}
              </select>
            </Field>
            <Field id="ar-role" label={t('areas.roles.role')}>
              <select id="ar-role" value={assign.role} onChange={(e) => setAssign({ ...assign, role: e.target.value })}>
                {SCOPABLE_ROLES.map((r) => <option key={r} value={r}>{ROLES[r]}</option>)}
              </select>
            </Field>
            <Field id="ar-area" label={t('areas.roles.area')}>
              <select id="ar-area" value={assign.areaId} onChange={(e) => setAssign({ ...assign, areaId: e.target.value })} required>
                <option value="">{t('areas.roles.choose')}</option>
                {list.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </Field>
            <div><button className="primary" disabled={busy}>{t('areas.roles.add')}</button></div>
          </form>
        )}
        {holders.length === 0 ? <p>{t('areas.roles.empty')}</p> : (
          <div className="table-wrap" tabIndex={0}><table>
            <thead><tr><th>{t('areas.roles.person')}</th><th>{t('areas.roles.title')}</th></tr></thead>
            <tbody>
              {holders.map((p) => (
                <tr key={p.id}>
                  <td><strong>{p.displayName}</strong><div className="small muted">{p.email}</div></td>
                  <td>
                    <ul style={{ margin: 0, paddingLeft: "1.2em" }}>
                      {p.scopedRoles.map((r) => (
                        <li key={`${r.role}-${r.areaId}`}>
                          {t('areas.scoped', { role: ROLES[r.role], area: areaName(r.areaId) })}{' '}
                          {r.source === 'idp' ? <span className="badge">{t('areas.roles.fromIdp')}</span> : (
                            <button type="button" className="link" disabled={busy}
                              aria-label={t('areas.roles.removeFor', { role: ROLES[r.role], area: areaName(r.areaId), name: p.displayName })}
                              onClick={() => setRoles(p, manual(p).filter((x) => !(x.role === r.role && x.areaId === r.areaId)))}>
                              {t('areas.roles.remove')}
                            </button>
                          )}
                        </li>
                      ))}
                    </ul>
                  </td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </section>
    </div>
  );
}
