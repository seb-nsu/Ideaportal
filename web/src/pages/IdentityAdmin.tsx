import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../api';
import { ErrorBox, Field, Loading, useAction, useLoad } from '../components';
import { ROLES } from '../labels';
import { formatDateTime, labelMap, t } from '../i18n';
import { SCOPABLE_ROLES, type Area } from './AreasAdmin';
import { SamlSettings, type CertInfo, type SamlConfig, type SamlSp } from './SamlSettings';

// Settings › Anmeldung (R3-26, R3-27): company login with OpenID Connect or SAML 2.0, groups → roles,
// local accounts switchable, SCIM tokens. The client secret is write-only.

// areaId (R3-29): the group grants the roles for this area only.
interface GroupRole { group: string; roles: string[]; areaId?: string | null }
interface Claims { email: string; name: string; department: string; groups: string }
interface IdentityConfig {
  /** Company login on (either protocol). */
  oidcEnabled: boolean;
  protocol: 'oidc' | 'saml';
  saml: SamlConfig;
  issuer: string;
  clientId: string;
  allowedDomains: string[];
  groupRoles: GroupRole[];
  jitProvisioning: boolean;
  localLoginDisabled: boolean;
  claims: Claims;
}
interface ScimToken { id: string; label: string; createdAt: string; lastUsedAt: string | null; revokedAt: string | null }
interface View {
  config: IdentityConfig;
  secretSet: boolean;
  redirectUri: string;
  scimUrl: string;
  tokens: ScimToken[];
  authMethod: string;
  samlSp: SamlSp;
  samlCerts: (CertInfo | null)[];
}

const CLAIM_KEYS = ['email', 'name', 'department', 'groups'] as const;
const CLAIM_LABELS = labelMap('identity.claim', CLAIM_KEYS);
const MAPPABLE = Object.keys(ROLES).filter((r) => r !== 'submitter');

export function IdentityAdmin() {
  const { data, error, loading, setData } = useLoad<View>('/api/admin/identity');
  const [cfg, setCfg] = useState<IdentityConfig | null>(null);
  const [domains, setDomains] = useState('');
  const [secret, setSecret] = useState('');
  const [deleteSecret, setDeleteSecret] = useState(false);
  const [saved, setSaved] = useState(false);
  const [check, setCheck] = useState<string | null>(null);
  const { busy, error: actionError, run } = useAction();
  const areas = useLoad<Area[]>('/api/admin/areas');

  useEffect(() => {
    if (!data) return;
    setCfg(data.config);
    setDomains(data.config.allowedDomains.join('\n'));
  }, [data]);

  if (loading && !data) return <Loading />;
  if (!data || !cfg) return <ErrorBox error={error} />;

  const update = (patch: Partial<IdentityConfig>) => {
    setSaved(false);
    setCfg({ ...cfg, ...patch });
  };
  const setRow = (i: number, row: GroupRole) => update({ groupRoles: cfg.groupRoles.map((r, j) => (j === i ? row : r)) });

  const save = async (e: FormEvent) => {
    e.preventDefault();
    const body = {
      ...cfg,
      allowedDomains: domains.split(/[\s,;]+/).map((d) => d.trim()).filter(Boolean),
      groupRoles: cfg.groupRoles.filter((r) => r.group.trim()),
      clientSecret: deleteSecret ? null : secret || undefined,
    };
    const r = await run(() => api.put<View>('/api/admin/identity', body));
    if (r) {
      setData(r);
      setSecret('');
      setDeleteSecret(false);
      setSaved(true);
    }
  };

  const checkIssuer = async () => {
    setCheck(null);
    const r = await run(() => api.post<{ ok: boolean; issuer?: string; reason?: string }>('/api/admin/identity/check', { issuer: cfg.issuer }));
    if (r) setCheck(r.ok ? t('identity.oidc.checkOk', { issuer: r.issuer }) : t('identity.oidc.checkFailed', { reason: r.reason }));
  };

  return (
    <div className="stack">
      <p className="muted">{t('identity.intro')}</p>
      <form className="stack" onSubmit={save}>
        <section className="card stack" aria-labelledby="h-oidc">
          <h2 id="h-oidc">{t(cfg.protocol === 'saml' ? 'saml.title' : 'identity.oidc.title')}</h2>
          <ErrorBox error={actionError} />
          {saved && <div className="alert success" role="status">{t('identity.saved')}</div>}
          <label className="check">
            <input type="checkbox" checked={cfg.oidcEnabled} onChange={(e) => update({ oidcEnabled: e.target.checked })} /> {t('identity.oidc.enabled')}
          </label>
          <fieldset>
            <legend>{t('saml.protocol')}</legend>
            <div className="row">
              {(['oidc', 'saml'] as const).map((p) => (
                <label key={p} className="check">
                  <input type="radio" name="sso-protocol" value={p} checked={cfg.protocol === p} onChange={() => update({ protocol: p })} />{' '}
                  {t(p === 'saml' ? 'saml.protocolSaml' : 'saml.protocolOidc')}
                </label>
              ))}
            </div>
            <p className="small muted">{t('saml.protocolHint')}</p>
          </fieldset>
          {cfg.protocol === 'saml' && (
            <SamlSettings value={cfg.saml} onChange={(patch) => update({ saml: { ...cfg.saml, ...patch } })} sp={data.samlSp} certs={data.samlCerts} />
          )}
          {cfg.protocol === 'oidc' && (<>
          <Field id="idp-redirect" label={t('identity.oidc.redirect')}>
            <input id="idp-redirect" type="text" readOnly value={data.redirectUri} onFocus={(e) => e.target.select()} />
          </Field>
          <div className="grid grid-2">
            <Field id="idp-issuer" label={t('identity.oidc.issuer')} hint={t('identity.oidc.issuerHint')}>
              <input id="idp-issuer" type="url" value={cfg.issuer} onChange={(e) => update({ issuer: e.target.value })} aria-describedby="idp-issuer-hint" />
            </Field>
            <Field id="idp-client" label={t('identity.oidc.clientId')}>
              <input id="idp-client" type="text" value={cfg.clientId} onChange={(e) => update({ clientId: e.target.value })} autoComplete="off" />
            </Field>
          </div>
          <div className="row">
            <button type="button" onClick={checkIssuer} disabled={busy || !cfg.issuer}>{t('identity.oidc.check')}</button>
            {check && <span role="status" className="small">{check}</span>}
          </div>
          <Field id="idp-secret" label={t('identity.oidc.secret')} hint={data.secretSet ? t('identity.oidc.secretSet') : t('identity.oidc.secretMissing')}>
            <input id="idp-secret" type="password" value={secret} onChange={(e) => { setSaved(false); setSecret(e.target.value); }} autoComplete="new-password" aria-describedby="idp-secret-hint" />
          </Field>
          {data.secretSet && (
            <label className="check">
              <input type="checkbox" checked={deleteSecret} onChange={(e) => setDeleteSecret(e.target.checked)} /> {t('identity.oidc.secretDelete')}
            </label>
          )}
          </>)}
          <Field id="idp-domains" label={t('identity.oidc.domains')} hint={t('identity.oidc.domainsHint')}>
            <textarea id="idp-domains" rows={3} value={domains} onChange={(e) => { setSaved(false); setDomains(e.target.value); }} aria-describedby="idp-domains-hint" />
          </Field>
          <label className="check">
            <input type="checkbox" checked={cfg.jitProvisioning} onChange={(e) => update({ jitProvisioning: e.target.checked })} /> {t('identity.oidc.jit')}
          </label>
          {cfg.protocol === 'oidc' && (
          <fieldset>
            <legend>{t('identity.oidc.claims')}</legend>
            <p className="small muted">{t('identity.oidc.claimsHint')}</p>
            <div className="grid grid-2">
              {CLAIM_KEYS.map((k) => (
                <Field key={k} id={`claim-${k}`} label={CLAIM_LABELS[k]}>
                  <input id={`claim-${k}`} type="text" value={cfg.claims[k]} onChange={(e) => update({ claims: { ...cfg.claims, [k]: e.target.value } })} />
                </Field>
              ))}
            </div>
          </fieldset>
          )}
        </section>

        <section className="card stack" aria-labelledby="h-groups">
          <h2 id="h-groups">{t('identity.groups.title')}</h2>
          <p className="small muted">{t('identity.groups.intro')}</p>
          {!!areas.data?.length && <p className="small muted">{t('areas.groupAreaHint')}</p>}
          {cfg.groupRoles.length === 0 && <p>{t('identity.groups.empty')}</p>}
          {cfg.groupRoles.length > 0 && (
            <div className="table-wrap" tabIndex={0}><table>
              <thead><tr><th>{t('identity.groups.group')}</th>{!!areas.data?.length && <th>{t('areas.groupArea')}</th>}<th>{t('identity.groups.roles')}</th><th /></tr></thead>
              <tbody>
                {cfg.groupRoles.map((row, i) => (
                  <tr key={i}>
                    <td>
                      <input type="text" value={row.group} aria-label={t('identity.groups.groupFor', { n: i + 1 })} onChange={(e) => setRow(i, { ...row, group: e.target.value })} />
                    </td>
                    {!!areas.data?.length && (
                      <td>
                        <select value={row.areaId ?? ''} aria-label={t('areas.groupAreaFor', { n: i + 1 })}
                          onChange={(e) => {
                            const areaId = e.target.value || null;
                            setRow(i, { ...row, areaId, roles: areaId ? row.roles.filter((r) => (SCOPABLE_ROLES as readonly string[]).includes(r)) : row.roles });
                          }}>
                          <option value="">{t('areas.tenantWide')}</option>
                          {areas.data.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                        </select>
                      </td>
                    )}
                    <td>
                      <div className="row">
                        {(row.areaId ? [...SCOPABLE_ROLES] : MAPPABLE).map((r) => (
                          <label key={r} className="check">
                            <input
                              type="checkbox"
                              aria-label={t('identity.groups.roleFor', { role: ROLES[r], n: i + 1 })}
                              checked={row.roles.includes(r)}
                              onChange={(e) => setRow(i, { ...row, roles: e.target.checked ? [...row.roles, r] : row.roles.filter((x) => x !== r) })}
                            /> {ROLES[r]}
                          </label>
                        ))}
                      </div>
                    </td>
                    <td>
                      <button type="button" className="link" onClick={() => update({ groupRoles: cfg.groupRoles.filter((_, j) => j !== i) })}>{t('identity.groups.remove')}</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          )}
          <div>
            <button type="button" onClick={() => update({ groupRoles: [...cfg.groupRoles, { group: '', roles: ['triage'] }] })}>{t('identity.groups.add')}</button>
          </div>
        </section>

        <section className="card stack" aria-labelledby="h-local">
          <h2 id="h-local">{t('identity.local.title')}</h2>
          <label className="check">
            <input type="checkbox" checked={cfg.localLoginDisabled} onChange={(e) => update({ localLoginDisabled: e.target.checked })} aria-describedby="local-hint" /> {t('identity.local.disable')}
          </label>
          <p className="small muted" id="local-hint">{t('identity.local.hint')}</p>
        </section>
        <div>
          <button className="primary" disabled={busy}>{t('identity.save')}</button>
        </div>
      </form>
      <ScimTokens view={data} onChange={(tokens) => setData({ ...data, tokens })} />
    </div>
  );
}

function ScimTokens({ view, onChange }: { view: View; onChange: (tokens: ScimToken[]) => void }) {
  const [label, setLabel] = useState('');
  const [shown, setShown] = useState<string | null>(null);
  const { busy, error, run } = useAction();

  const reload = async () => {
    const r = await run(() => api.get<View>('/api/admin/identity'));
    if (r) onChange(r.tokens);
  };
  const create = async (e: FormEvent) => {
    e.preventDefault();
    const r = await run(() => api.post<{ id: string; token: string }>('/api/admin/identity/scim-tokens', { label }));
    if (r) {
      setShown(r.token);
      setLabel('');
      await reload();
    }
  };
  const revoke = async (tok: ScimToken) => {
    if (!window.confirm(t('identity.scim.revokeConfirm', { label: tok.label }))) return;
    if (await run(() => api.del(`/api/admin/identity/scim-tokens/${tok.id}`))) await reload();
  };

  return (
    <section className="card stack" aria-labelledby="h-scim">
      <h2 id="h-scim">{t('identity.scim.title')}</h2>
      <p className="small muted">{t('identity.scim.intro')}</p>
      <ErrorBox error={error} />
      <Field id="scim-url" label={t('identity.scim.url')}>
        <input id="scim-url" type="text" readOnly value={view.scimUrl} onFocus={(e) => e.target.select()} />
      </Field>
      <form className="row" onSubmit={create}>
        <Field id="scim-label" label={t('identity.scim.label')}>
          <input id="scim-label" type="text" value={label} onChange={(e) => setLabel(e.target.value)} required maxLength={80} />
        </Field>
        <button className="primary" disabled={busy || !label.trim()}>{t('identity.scim.create')}</button>
      </form>
      {shown && (
        <div className="alert success" role="status">
          {t('identity.scim.tokenOnce')} <code style={{ wordBreak: 'break-all' }}>{shown}</code>
        </div>
      )}
      <h3>{t('identity.scim.tokens')}</h3>
      {view.tokens.length === 0 ? (
        <p>{t('identity.scim.noTokens')}</p>
      ) : (
        <div className="table-wrap" tabIndex={0}><table>
          <thead>
            <tr><th>{t('identity.scim.label')}</th><th>{t('identity.scim.created')}</th><th>{t('identity.scim.lastUsed')}</th><th>{t('identity.scim.status')}</th><th /></tr>
          </thead>
          <tbody>
            {view.tokens.map((tok) => (
              <tr key={tok.id}>
                <td>{tok.label}</td>
                <td>{formatDateTime(tok.createdAt)}</td>
                <td>{tok.lastUsedAt ? formatDateTime(tok.lastUsedAt) : t('identity.scim.never')}</td>
                <td>{tok.revokedAt ? <span className="badge">{t('identity.scim.revoked')}</span> : <span className="badge green">{t('identity.scim.active')}</span>}</td>
                <td>
                  {!tok.revokedAt && (
                    <button type="button" className="link" disabled={busy} onClick={() => revoke(tok)} aria-label={t('identity.scim.revokeFor', { label: tok.label })}>{t('identity.scim.revoke')}</button>
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
