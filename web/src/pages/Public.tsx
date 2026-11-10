import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ApiError, api, type PublicConfig } from '../api';
import { ErrorBox, Field, Loading, useAction, useLoad } from '../components';
import { getLocale, t } from '../i18n';
import { LanguageSwitch } from '../LanguageSwitch';

// Public pages for the self-service product: landing page, sign-up, joining by link, demo.

const DEMO_ROLES = ['submitter', 'triage', 'committee', 'owner', 'admin'] as const;
const demoRoles = (): { role: string; title: string; text: string }[] =>
  DEMO_ROLES.map((role) => ({ role, title: t(`publicPages.demo.${role}.title`), text: t(`publicPages.demo.${role}.text`) }));

export function usePublicConfig() {
  return useLoad<PublicConfig>('/api/public-config').data;
}

export function DemoPicker({ onLoggedIn, compact = false }: { onLoggedIn(): Promise<void>; compact?: boolean }) {
  const navigate = useNavigate();
  const { busy, error, run } = useAction();
  const start = async (role: string) => {
    if (await run(() => api.post('/api/demo/login', { role, locale: getLocale() }))) {
      await onLoggedIn();
      navigate('/');
    }
  };
  return (
    <div>
      <ErrorBox error={error} />
      <div className={compact ? 'row' : 'grid grid-3'}>
        {demoRoles().map((r) =>
          compact ? (
            <button key={r.role} type="button" disabled={busy} onClick={() => start(r.role)}>{r.title}</button>
          ) : (
            <button key={r.role} type="button" className="role-card" disabled={busy} onClick={() => start(r.role)}>
              <strong>{r.title}</strong>
              <span className="small muted">{r.text}</span>
            </button>
          ),
        )}
      </div>
    </div>
  );
}

export function Landing({ onLoggedIn }: { onLoggedIn(): Promise<void> }) {
  const config = usePublicConfig();
  useEffect(() => {
    document.title = t('publicPages.landing.docTitle');
  }, []);
  return (
    <div className="landing">
      <header className="topbar">
        <span className="brand">Ideenportal</span>{/* texts-ok */}
        <nav className="nav" aria-label={t('publicPages.landing.navLabel')}>
          <a href="#so-gehts">{t('publicPages.landing.navFlow')}</a>
          <a href="#funktionen">{t('publicPages.landing.navFeatures')}</a>
          {config?.demo && <a href="#demo">{t('publicPages.landing.navDemo')}</a>}
        </nav>
        <div className="topbar-right">
          <LanguageSwitch />
          <Link to="/login" className="button">{t('publicPages.landing.login')}</Link>
          {config?.signup && <Link to="/registrieren" className="button primary">{t('publicPages.landing.startFree')}</Link>}
        </div>
      </header>
      <main id="inhalt">
        <section className="hero">
          <h1>{t('publicPages.landing.heroTitle')}</h1>
          <p className="lead">
            {t('publicPages.landing.heroLead')}
          </p>
          <div className="row">
            {config?.signup && <Link to="/registrieren" className="button primary">{t('publicPages.landing.createWorkspace')}</Link>}
            {config?.demo && <a href="#demo" className="button">{t('publicPages.landing.viewDemo')}</a>}
          </div>
          <p className="small muted">{t('publicPages.landing.noSso')}</p>
        </section>

        <section id="so-gehts" aria-labelledby="h-flow">
          <h2 id="h-flow">{t('publicPages.landing.flowTitle')}</h2>
          <ol className="flow">
            <li><strong>{t('publicPages.landing.flow1.title')}</strong><span>{t('publicPages.landing.flow1.text')}</span></li>
            <li><strong>{t('publicPages.landing.flow2.title')}</strong><span>{t('publicPages.landing.flow2.text')}</span></li>
            <li><strong>{t('publicPages.landing.flow3.title')}</strong><span>{t('publicPages.landing.flow3.text')}</span></li>
            <li><strong>{t('publicPages.landing.flow4.title')}</strong><span>{t('publicPages.landing.flow4.text')}</span></li>
          </ol>
        </section>

        <section id="funktionen" aria-labelledby="h-features">
          <h2 id="h-features">{t('publicPages.landing.featuresTitle')}</h2>
          <div className="grid grid-3">
            <div className="card"><h3>{t('publicPages.landing.f1.title')}</h3><p>{t('publicPages.landing.f1.text')}</p></div>
            <div className="card"><h3>{t('publicPages.landing.f2.title')}</h3><p>{t('publicPages.landing.f2.text')}</p></div>
            <div className="card"><h3>{t('publicPages.landing.f3.title')}</h3><p>{t('publicPages.landing.f3.text')}</p></div>
            <div className="card"><h3>{t('publicPages.landing.f4.title')}</h3><p>{t('publicPages.landing.f4.text')}</p></div>
            <div className="card"><h3>{t('publicPages.landing.f5.title')}</h3><p>{t('publicPages.landing.f5.text')}</p></div>
            <div className="card"><h3>{t('publicPages.landing.f6.title')}</h3><p>{t('publicPages.landing.f6.text')}</p></div>
          </div>
        </section>

        {config?.demo && (
          <section id="demo" aria-labelledby="h-demo">
            <h2 id="h-demo">{t('publicPages.landing.demoTitle')}</h2>
            <p>{t('publicPages.landing.demoIntro')}</p>
            <DemoPicker onLoggedIn={onLoggedIn} />
          </section>
        )}
      </main>
      <footer className="footer small muted">
        <p>{t('publicPages.landing.footer')}</p>
        <p><Link to="/rechtliches">{t('compliance.footerLink')}</Link></p>
      </footer>
    </div>
  );
}

function PasswordFields({ password, setPassword }: { password: string; setPassword: (v: string) => void }) {
  return (
    <Field id="password" label={t('publicPages.password.label')} hint={t('publicPages.password.hint')}>
      <input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={10} required autoComplete="new-password" aria-describedby="password-hint" />
    </Field>
  );
}

function PrivacyCheck({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="check field">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} required />
      <span>
        {t('publicPages.privacy.text')}
      </span>
    </label>
  );
}

export function Signup({ onLoggedIn }: { onLoggedIn(): Promise<void> }) {
  const config = usePublicConfig();
  const navigate = useNavigate();
  const [workspace, setWorkspace] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [privacy, setPrivacy] = useState(false);
  const [exampleData, setExampleData] = useState(true);
  const { busy, error, run, setError } = useAction();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!privacy) return setError(new ApiError(400, t('publicPages.privacy.required')));
    if (await run(() => api.post('/api/signup', { workspace, name, email, password, acceptPrivacy: true, exampleData, locale: getLocale() }))) {
      await onLoggedIn();
      navigate('/');
    }
  };

  if (config && !config.signup) {
    return (
      <main className="login-wrap">
        <div className="card">
          <h1>{t('publicPages.signup.closedTitle')}</h1>
          <p>{t('publicPages.signup.closedText')}</p>
          <Link to="/login">{t('publicPages.toLogin')}</Link>
        </div>
      </main>
    );
  }
  return (
    <main className="login-wrap">
      <div className="card">
        <h1>{t('publicPages.signup.title')}</h1>
        <p className="muted">{t('publicPages.signup.intro')}</p>
        <form onSubmit={submit} noValidate>
          <ErrorBox error={error} />
          <Field id="workspace" label={t('publicPages.signup.workspace')} hint={t('publicPages.signup.workspaceHint')}>
            <input id="workspace" type="text" value={workspace} onChange={(e) => setWorkspace(e.target.value)} required autoComplete="organization" aria-describedby="workspace-hint" />
          </Field>
          <Field id="name" label={t('publicPages.yourName')}>
            <input id="name" type="text" value={name} onChange={(e) => setName(e.target.value)} required autoComplete="name" />
          </Field>
          <Field id="email" label={t('publicPages.email')}>
            <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
          </Field>
          <PasswordFields password={password} setPassword={setPassword} />
          <label className="check field">
            <input type="checkbox" checked={exampleData} onChange={(e) => setExampleData(e.target.checked)} />
            <span>{t('publicPages.signup.exampleData')}</span>
          </label>
          <PrivacyCheck checked={privacy} onChange={setPrivacy} />
          <button className="primary" disabled={busy}>{t('publicPages.signup.submit')}</button>
        </form>
      </div>
      <p className="small muted" style={{ textAlign: 'center', marginTop: 16 }}>
        {t('publicPages.haveAccount')} <Link to="/login">{t('publicPages.login')}</Link> · <Link to="/">{t('publicPages.toHome')}</Link>
      </p>
      <LanguageSwitch />
    </main>
  );
}

export function Join({ onLoggedIn }: { onLoggedIn(): Promise<void> }) {
  const { code } = useParams();
  const navigate = useNavigate();
  const { data, error: loadError, loading } = useLoad<{ name: string }>(`/api/join/${code}`);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [privacy, setPrivacy] = useState(false);
  const { busy, error, run, setError } = useAction();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!privacy) return setError(new ApiError(400, t('publicPages.privacy.required')));
    if (await run(() => api.post(`/api/join/${code}`, { name, email, password, acceptPrivacy: true, locale: getLocale() }))) {
      await onLoggedIn();
      navigate('/');
    }
  };

  return (
    <main className="login-wrap">
      <div className="card">
        {loading && !data ? (
          <Loading />
        ) : loadError || !data ? (
          <>
            <h1>{t('publicPages.join.invalidTitle')}</h1>
            <ErrorBox error={loadError ?? t('publicPages.join.invalidText')} />
            <Link to="/login">{t('publicPages.toLogin')}</Link>
          </>
        ) : (
          <>
            <h1>{t('publicPages.join.title', { name: data.name })}</h1>
            <p className="muted">{t('publicPages.join.intro')}</p>
            <form onSubmit={submit} noValidate>
              <ErrorBox error={error} />
              <Field id="name" label={t('publicPages.yourName')}>
                <input id="name" type="text" value={name} onChange={(e) => setName(e.target.value)} required autoComplete="name" />
              </Field>
              <Field id="email" label={t('publicPages.email')}>
                <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
              </Field>
              <PasswordFields password={password} setPassword={setPassword} />
              <PrivacyCheck checked={privacy} onChange={setPrivacy} />
              <button className="primary" disabled={busy}>{t('publicPages.join.submit')}</button>
            </form>
            <p className="small muted" style={{ marginTop: 12 }}>
              {t('publicPages.haveAccount')} <Link to="/login">{t('publicPages.login')}</Link>
            </p>
          </>
        )}
      </div>
      <LanguageSwitch />
    </main>
  );
}
