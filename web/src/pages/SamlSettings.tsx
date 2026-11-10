import { useState } from 'react';
import { api } from '../api';
import { ErrorBox, Field, useAction } from '../components';
import { formatDate, labelMap, t, type MessageKey } from '../i18n';

// Settings › Anmeldung, protocol SAML 2.0 (R3-26): values for the identity provider (entity ID,
// ACS URL, SP metadata), IdP metadata import, certificates (two for the rollover), attribute
// names with defaults for Entra ID, Okta and ADFS, and "Verbindung prüfen".

export interface SamlAttributes {
  email: string;
  name: string;
  department: string;
  groups: string;
}
export interface SamlConfig {
  metadataUrl: string;
  idpEntityId: string;
  ssoUrl: string;
  certs: string[];
  attributes: SamlAttributes;
  allowIdpInitiated: boolean;
}
export interface SamlSp {
  entityId: string;
  acsUrl: string;
  metadataUrl: string;
}
export interface CertInfo {
  subject: string;
  validFrom: string;
  validTo: string;
  daysLeft: number;
  fingerprint: string;
}
interface CheckReport {
  ok: boolean;
  problems: string[];
  warnings: string[];
  certs: CertInfo[];
}
interface Metadata {
  idpEntityId: string;
  ssoUrl: string;
  certs: string[];
}

const ATTR_KEYS = ['email', 'name', 'department', 'groups'] as const;
const ATTR_LABELS = labelMap('saml.attr', ATTR_KEYS);
const WARN_DAYS = 30;

// Attribute names as the identity providers send them by default (technical identifiers).
const PRESETS: Record<'entra' | 'okta' | 'adfs', SamlAttributes> = {
  entra: {
    email: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
    name: 'http://schemas.microsoft.com/identity/claims/displayname',
    department: 'department',
    groups: 'http://schemas.microsoft.com/ws/2008/06/identity/claims/groups',
  },
  okta: { email: 'email', name: 'displayName', department: 'department', groups: 'groups' },
  adfs: {
    email: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
    name: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name',
    department: 'department',
    groups: 'http://schemas.xmlsoap.org/claims/Group',
  },
};
const PRESET_LABELS: Record<keyof typeof PRESETS, MessageKey> = { entra: 'saml.presetEntra', okta: 'saml.presetOkta', adfs: 'saml.presetAdfs' };

/** Text for a problem or warning code of the check; unknown codes get the generic text. */
function codeText(kind: 'problem' | 'warning', code: string): string {
  const key = `saml.${kind}.${code}` as MessageKey;
  const text = t(key);
  return text === key ? t('saml.problem.other', { code }) : text;
}

function CopyField({ id, label, value }: { id: string; label: string; value: string }) {
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
    <Field id={id} label={label}>
      <div className="row">
        <input id={id} type="text" readOnly value={value} onFocus={(e) => e.target.select()} style={{ flex: 1 }} />
        <button type="button" onClick={copy} aria-label={t('saml.copyFor', { label })}>
          {t('saml.copy')}
        </button>
        {copied && (
          <span role="status" className="small">
            {t('saml.copied')}
          </span>
        )}
      </div>
    </Field>
  );
}

function CertLine({ info }: { info: CertInfo | null | undefined }) {
  if (!info) return null;
  if (info.daysLeft < 0)
    return (
      <p className="small alert error">
        {t('saml.certExpiredShort')} {info.subject}
      </p>
    );
  return (
    <p className={`small${info.daysLeft < WARN_DAYS ? ' alert warn' : ' muted'}`}>
      {t('saml.certInfo', { subject: info.subject, date: formatDate(info.validTo), days: info.daysLeft })}
      {info.daysLeft < WARN_DAYS && <> {t('saml.certExpiring', { days: info.daysLeft })}</>}
    </p>
  );
}

export function SamlSettings({
  value,
  onChange,
  sp,
  certs,
}: {
  value: SamlConfig;
  onChange(patch: Partial<SamlConfig>): void;
  sp: SamlSp;
  certs: (CertInfo | null)[];
}) {
  const [xml, setXml] = useState('');
  const [imported, setImported] = useState(false);
  const [report, setReport] = useState<CheckReport | null>(null);
  const { busy, error, run } = useAction();

  const takeOver = (md: Metadata) => {
    onChange({ idpEntityId: md.idpEntityId, ssoUrl: md.ssoUrl, certs: md.certs.slice(0, 2) });
    setImported(true);
  };
  const load = async (body: { url?: string; xml?: string }) => {
    setImported(false);
    const r = await run(() => api.post<Metadata>('/api/admin/identity/saml/metadata', body));
    if (r) takeOver(r);
  };
  const check = async () => {
    setReport(null);
    const r = await run(() => api.post<CheckReport>('/api/admin/identity/saml/check', value));
    if (r) setReport(r);
  };
  const setCert = (i: number, pem: string) => {
    const next = [value.certs[0] ?? '', value.certs[1] ?? ''];
    next[i] = pem;
    onChange({ certs: next.filter((c) => c.trim()) });
  };

  return (
    <div className="stack">
      <fieldset className="stack">
        <legend>{t('saml.sp.title')}</legend>
        <p className="small muted">{t('saml.sp.intro')}</p>
        <CopyField id="saml-entity" label={t('saml.sp.entityId')} value={sp.entityId} />
        <CopyField id="saml-acs" label={t('saml.sp.acsUrl')} value={sp.acsUrl} />
        <CopyField id="saml-md" label={t('saml.sp.metadata')} value={sp.metadataUrl} />
        <div>
          <a className="button" href={`${sp.metadataUrl}?download`} download>
            {t('saml.sp.download')}
          </a>
        </div>
      </fieldset>

      <fieldset className="stack">
        <legend>{t('saml.import.title')}</legend>
        <ErrorBox error={error} />
        {imported && (
          <div className="alert success" role="status">
            {t('saml.import.done')}
          </div>
        )}
        <Field id="saml-md-url" label={t('saml.import.url')} hint={t('saml.import.urlHint')}>
          <input
            id="saml-md-url"
            type="url"
            value={value.metadataUrl}
            onChange={(e) => onChange({ metadataUrl: e.target.value })}
            aria-describedby="saml-md-url-hint"
          />
        </Field>
        <div>
          <button type="button" onClick={() => load({ url: value.metadataUrl })} disabled={busy || !value.metadataUrl}>
            {t('saml.import.load')}
          </button>
        </div>
        <Field id="saml-md-xml" label={t('saml.import.xml')}>
          <textarea id="saml-md-xml" rows={4} value={xml} onChange={(e) => setXml(e.target.value)} spellCheck={false} />
        </Field>
        <div>
          <button type="button" onClick={() => load({ xml })} disabled={busy || !xml.trim()}>
            {t('saml.import.fromXml')}
          </button>
        </div>
      </fieldset>

      <div className="grid grid-2">
        <Field id="saml-idp-entity" label={t('saml.idpEntityId')} hint={t('saml.idpEntityIdHint')}>
          <input
            id="saml-idp-entity"
            type="text"
            value={value.idpEntityId}
            onChange={(e) => onChange({ idpEntityId: e.target.value })}
            aria-describedby="saml-idp-entity-hint"
          />
        </Field>
        <Field id="saml-sso" label={t('saml.ssoUrl')}>
          <input id="saml-sso" type="url" value={value.ssoUrl} onChange={(e) => onChange({ ssoUrl: e.target.value })} />
        </Field>
      </div>
      {[0, 1].map((i) => (
        <div key={i}>
          <Field id={`saml-cert-${i}`} label={t(i === 0 ? 'saml.cert1' : 'saml.cert2')} hint={t('saml.certHint')}>
            <textarea
              id={`saml-cert-${i}`}
              rows={4}
              value={value.certs[i] ?? ''}
              onChange={(e) => setCert(i, e.target.value)}
              spellCheck={false}
              aria-describedby={`saml-cert-${i}-hint`}
            />
          </Field>
          <CertLine info={certs[i]} />
        </div>
      ))}

      <fieldset>
        <legend>{t('saml.attributes')}</legend>
        <p className="small muted">{t('saml.attributesHint')}</p>
        <div className="row">
          <span className="small">{t('saml.preset')}</span>
          {(Object.keys(PRESETS) as (keyof typeof PRESETS)[]).map((p) => (
            <button key={p} type="button" className="link" onClick={() => onChange({ attributes: { ...PRESETS[p] } })}>
              {t(PRESET_LABELS[p])}
            </button>
          ))}
        </div>
        <div className="grid grid-2">
          {ATTR_KEYS.map((k) => (
            <Field key={k} id={`saml-attr-${k}`} label={ATTR_LABELS[k]}>
              <input
                id={`saml-attr-${k}`}
                type="text"
                value={value.attributes[k]}
                onChange={(e) => onChange({ attributes: { ...value.attributes, [k]: e.target.value } })}
              />
            </Field>
          ))}
        </div>
      </fieldset>

      <label className="check">
        <input
          type="checkbox"
          checked={value.allowIdpInitiated}
          onChange={(e) => onChange({ allowIdpInitiated: e.target.checked })}
          aria-describedby="saml-idp-init-hint"
        />{' '}
        {t('saml.idpInitiated')}
      </label>
      <p className="small muted" id="saml-idp-init-hint">
        {t('saml.idpInitiatedHint')}
      </p>

      <div className="row">
        <button type="button" onClick={check} disabled={busy}>
          {t('saml.check')}
        </button>
      </div>
      {report && (
        <div role="status" className={`alert ${report.ok && !report.warnings.length ? 'success' : report.ok ? 'warn' : 'error'}`}>
          {report.ok && !report.warnings.length && <p>{t('saml.checkOk')}</p>}
          {report.problems.length > 0 && (
            <>
              <p>{t('saml.checkProblems')}</p>
              <ul>
                {report.problems.map((p) => (
                  <li key={p}>{codeText('problem', p)}</li>
                ))}
              </ul>
            </>
          )}
          {report.warnings.length > 0 && (
            <>
              <p>{t('saml.checkWarnings')}</p>
              <ul>
                {report.warnings.map((w) => (
                  <li key={w}>{codeText('warning', w)}</li>
                ))}
              </ul>
            </>
          )}
          {report.certs.map((c) => (
            <CertLine key={c.fingerprint} info={c} />
          ))}
        </div>
      )}
    </div>
  );
}
