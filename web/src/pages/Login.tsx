import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ApiError, api } from '../api';
import { ErrorBox, Field, useAction } from '../components';
import { t, type MessageKey } from '../i18n';
import { LanguageSwitch } from '../LanguageSwitch';

// Company login (R3-26): the login page asks whether the workspace (by slug or e-mail domain)
// has a company login and then shows the button. Errors come back as /login?sso=<reason>.
interface Sso { available: boolean; tenant?: string; name?: string; localLogin?: boolean; protocol?: 'oidc' | 'saml' }
const SSO_ERRORS = ['state', 'provider', 'denied', 'domain', 'no_account', 'inactive', 'not_configured'];

async function lookupSso(query: string): Promise<Sso | null> {
  try {
    const r = await api.get<Sso>(`/api/auth/sso?${query}`);
    return r.available ? r : null;
  } catch {
    return null;
  }
}

/** Start of the company login: OpenID Connect or SAML 2.0, depending on the workspace. */
function ssoStartUrl(sso: Sso, q: URLSearchParams): string {
  if (sso.protocol !== 'saml') return `/api/auth/oidc/start?${q.toString()}`;
  const rest = new URLSearchParams(q);
  rest.delete('tenant');
  return `/api/auth/saml/${encodeURIComponent(sso.tenant ?? '')}/login?${rest.toString()}`;
}

function SsoButton({ sso, email, weiter }: { sso: Sso; email: string; weiter: string | null }) {
  const q = new URLSearchParams({ tenant: sso.tenant ?? '' });
  if (weiter) q.set('weiter', weiter);
  if (email.includes('@')) q.set('login_hint', email);
  return (
    <div className="stack" style={{ marginBottom: 16 }}>
      <a className="button primary" href={ssoStartUrl(sso, q)}>{t('identity.login.button')}</a>
      {sso.localLogin === false ? <p className="small muted">{t('identity.login.ssoOnly')}</p> : <p className="small muted">{t('identity.login.or')}</p>}
    </div>
  );
}

export function Login({ onLoggedIn }: { onLoggedIn(): Promise<void> }) {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [choices, setChoices] = useState<{ slug: string; name: string }[] | null>(null);
  const [resetSent, setResetSent] = useState(false);
  const { busy, error, run } = useAction();
  const tenant = params.get('mandant') ?? undefined;
  const [sso, setSso] = useState<Sso | null>(null);
  const ssoError = params.get('sso');

  useEffect(() => {
    if (tenant) void lookupSso(`tenant=${encodeURIComponent(tenant)}`).then(setSso);
  }, [tenant]);

  const checkDomain = async () => {
    if (tenant || !email.includes('@')) return;
    setSso(await lookupSso(`email=${encodeURIComponent(email.trim())}`));
  };

  const login = async (workspace?: string) => {
    let ssoTenant: string | undefined;
    const res = await run(() => api.post<{ chooseWorkspace?: { slug: string; name: string }[] }>('/api/auth/login', { tenant: workspace ?? tenant, email, password }).catch((e: unknown) => {
      // Workspace with company login only: show the button (R3-26).
      if (e instanceof ApiError && e.code === 'SSO_REQUIRED') ssoTenant = (e.details as { tenant?: string } | undefined)?.tenant;
      throw e;
    }));
    if (ssoTenant) setSso(await lookupSso(`tenant=${encodeURIComponent(ssoTenant)}`));
    if (!res) return;
    if (res.chooseWorkspace) return setChoices(res.chooseWorkspace);
    await onLoggedIn();
    navigate(params.get('weiter') ?? '/');
  };

  const reset = async () => {
    const ok = await run(() => api.post('/api/auth/reset-request', { tenant, email }));
    if (ok) setResetSent(true);
  };

  return (
    <main className="login-wrap">
      <div className="card">
        <h1>{t('login.title')}</h1>
        <p className="muted">{t('login.tagline')}</p>
        {choices ? (
          <div>
            <h2>{t('login.chooseWorkspace')}</h2>
            <p>{t('login.multipleAccounts')}</p>
            <ErrorBox error={error} />
            <ul className="idea-list">
              {choices.map((c) => (
                <li key={c.slug}>
                  <button type="button" className="primary" disabled={busy} onClick={() => login(c.slug)}>{c.name}</button>
                </li>
              ))}
            </ul>
            <button type="button" className="link" onClick={() => setChoices(null)}>{t('login.back')}</button>
          </div>
        ) : (
          <>
          {ssoError && SSO_ERRORS.includes(ssoError) && <ErrorBox error={t(`identity.login.error.${ssoError}` as MessageKey)} />}
          {sso && <SsoButton sso={sso} email={email} weiter={params.get('weiter')} />}
          {sso?.localLogin !== false && (
          <form onSubmit={(e: FormEvent) => { e.preventDefault(); void login(); }} noValidate>
            <ErrorBox error={error} />
            {resetSent && <div className="alert success" role="status">{t('login.resetSent')}</div>}
            <Field id="email" label={t('login.email')}>
              <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} onBlur={checkDomain} required autoComplete="username" />
            </Field>
            <Field id="password" label={t('login.password')}>
              <input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" />
            </Field>
            <div className="row spread">
              <button className="primary" type="submit" disabled={busy}>{t('login.submit')}</button>
              <button type="button" className="link" onClick={reset} disabled={!email}>{t('login.forgotPassword')}</button>
            </div>
          </form>
          )}
          </>
        )}
      </div>
      <p className="small muted" style={{ textAlign: 'center', marginTop: 16 }}>
        {t('login.noAccount')} <Link to="/registrieren">{t('login.createWorkspace')}</Link> · <Link to="/">{t('login.toHome')}</Link>
      </p>
      <LanguageSwitch />
    </main>
  );
}

export function SetPassword() {
  const [params] = useSearchParams();
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [done, setDone] = useState(false);
  const { busy, error, run, setError } = useAction();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password !== repeat) return setError(new ApiError(400, t('login.setPassword.mismatch')));
    const ok = await run(() => api.post('/api/auth/set-password', { token: params.get('token'), password }));
    if (ok) setDone(true);
  };
  return (
    <main className="login-wrap">
      <div className="card">
        <h1>{t('login.setPassword.title')}</h1>
        {done ? (
          <div className="alert success" role="status">
            {t('login.setPassword.done')} <a href="/login">{t('login.setPassword.loginNow')}</a>
          </div>
        ) : (
          <form onSubmit={submit}>
            <ErrorBox error={error} />
            <Field id="pw" label={t('login.setPassword.new')} hint={t('login.setPassword.hint')}>
              <input id="pw" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" minLength={10} required />
            </Field>
            <Field id="pw2" label={t('login.setPassword.repeat')}>
              <input id="pw2" type="password" value={repeat} onChange={(e) => setRepeat(e.target.value)} autoComplete="new-password" required />
            </Field>
            <button className="primary" disabled={busy}>{t('login.setPassword.save')}</button>
          </form>
        )}
      </div>
    </main>
  );
}

export function MfaChallenge({ onDone }: { onDone(): Promise<void> }) {
  const [code, setCode] = useState('');
  const { busy, error, run } = useAction();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (await run(() => api.post('/api/auth/mfa', { code }))) await onDone();
  };
  return (
    <main className="login-wrap">
      <div className="card">
        <h1>{t('login.mfa.title')}</h1>
        <p>{t('login.mfa.intro')}</p>
        <form onSubmit={submit}>
          <ErrorBox error={error} />
          <Field id="code" label={t('login.mfa.code')}>
            <input id="code" type="text" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} required />
          </Field>
          <button className="primary" disabled={busy}>{t('login.mfa.confirm')}</button>
        </form>
      </div>
    </main>
  );
}

export function MfaSetup({ onDone }: { onDone(): Promise<void> }) {
  const [setup, setSetup] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [code, setCode] = useState('');
  const { busy, error, run } = useAction();
  const start = async () => {
    const r = await run(() => api.post<{ secret: string; otpauthUrl: string }>('/api/auth/mfa/setup'));
    if (r) setSetup(r);
  };
  const enable = async (e: FormEvent) => {
    e.preventDefault();
    if (await run(() => api.post('/api/auth/mfa/enable', { code }))) await onDone();
  };
  return (
    <main className="login-wrap">
      <div className="card">
        <h1>{t('login.mfaSetup.title')}</h1>
        <p>{t('login.mfaSetup.intro')}</p>
        <ErrorBox error={error} />
        {!setup ? (
          <button className="primary" onClick={start} disabled={busy}>{t('login.mfaSetup.start')}</button>
        ) : (
          <form onSubmit={enable}>
            <p>{t('login.mfaSetup.enterKey')}</p>
            <p><code style={{ fontSize: '1.1rem', wordBreak: 'break-all' }}>{setup.secret}</code></p>
            <p className="small muted">{t('login.mfaSetup.orLink')} <a href={setup.otpauthUrl}>{t('login.mfaSetup.addAccount')}</a></p>
            <Field id="code" label={t('login.mfaSetup.code')}>
              <input id="code" type="text" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} required />
            </Field>
            <button className="primary" disabled={busy}>{t('login.mfaSetup.activate')}</button>
          </form>
        )}
        <p className="small" style={{ marginTop: 16 }}>
          <button className="link" onClick={() => api.post('/api/auth/logout').then(() => (window.location.href = '/login'))}>{t('login.mfaSetup.logout')}</button>
        </p>
      </div>
    </main>
  );
}
