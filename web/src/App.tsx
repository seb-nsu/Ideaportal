import { useCallback, useEffect, useState } from 'react';
import { Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { ApiError, api, type Me, type PublicSettings } from './api';
import { Loading } from './components';
import { Account } from './pages/Account';
import { AiProofs } from './pages/AiProofs';
import { AiTransparency } from './pages/AiTransparency';
import { Codetermination } from './pages/Codetermination';
import { Admin } from './pages/Admin';
import { Board } from './pages/Board';
import { ChallengeDetail, Challenges } from './pages/Challenges';
import { Dashboard } from './pages/Dashboard';
import { Help } from './pages/Help';
import { Home } from './pages/Home';
import { IdeaDetail } from './pages/IdeaDetail';
import { Ideas } from './pages/Ideas';
import { Login, MfaChallenge, MfaSetup, SetPassword } from './pages/Login';
import { MeetingDetail, Meetings } from './pages/Meetings';
import { Portfolio } from './pages/Portfolio';
import { Calibration } from './pages/Calibration';
import { Certificate, Success } from './pages/Success';
import { DemoPicker, Join, Landing, Signup } from './pages/Public';
import { Benchmark } from './pages/Benchmark';
import { Notifications } from './pages/Notifications';
import { Onboarding, TourContext } from './pages/Onboarding';
import { Steckbrief } from './pages/idea/Steckbrief';
import { Submit } from './pages/Submit';
import { Tasks } from './pages/Tasks';
import { LegalPage } from './pages/Legal';
import { Status } from './pages/Status';
import { Operator } from './pages/Operator';
import { ExternalJoin, ExternalShell } from './pages/External';
import { ExternalAdmin } from './pages/ExternalAdmin';
import { FeatureRequests, FeatureStatusPage } from './pages/FeatureRequests';
import { Moderation } from './pages/Moderation';
import { SessionContext, useSession, type Session } from './session';
import { BottomBar, InsightsTabs, MainNav, SubNav, useAreas } from './navigation';
import { PlanBanner, PlanProvider } from './plan';
import { getLocale, onLocaleChange, setLocale, t } from './i18n';
import { BenefitConfirmations, ChallengeTeams } from './pages/ChallengeUseCases';
import { Radar } from './pages/Radar';

// Status page (R3-10) and operator console (R3-07) work without a workspace session.
const PUBLIC = ['/login', '/passwort', '/registrieren', '/status', '/betrieb', '/benchmark'];
// Legal texts (R3-11) are public with and without a session.
const isPublic = (path: string) => PUBLIC.includes(path) || path.startsWith('/beitreten/') || path === '/rechtliches' || path.startsWith('/rechtliches/')
  // Portal link for external participants (R3-19) and public status page of feature requests (R3-20).
  || path.startsWith('/mitmachen/') || path.startsWith('/statusseite/');

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [state, setState] = useState<'loading' | 'anon' | 'mfa' | 'mfa-setup' | 'ready'>('loading');
  const location = useLocation();
  // Re-render on a language change, e.g. from the switch on the public pages (R3-22).
  const [locale, setLocaleState] = useState(getLocale());
  useEffect(() => onLocaleChange(setLocaleState), []);

  const refresh = useCallback(async () => {
    try {
      const me = await api.get<Me>('/api/me');
      // The person's language wins over the browser's (R2-50).
      if (me.user?.locale && me.user.locale !== getLocale()) setLocale(me.user.locale);
      if (me.mfaPending) return setState('mfa');
      if (me.mfaSetupRequired) {
        setSession({ me, settings: null as unknown as PublicSettings, refresh });
        return setState('mfa-setup');
      }
      // External people (R3-19) have their own pages and no access to the workspace settings.
      const settings = me.user.roles.includes('external') ? (null as unknown as PublicSettings) : await api.get<PublicSettings>('/api/settings');
      setSession({ me, settings, refresh });
      setState('ready');
    } catch (e) {
      if (e instanceof ApiError && e.status === 401 && e.code === 'MFA_REQUIRED') return setState('mfa');
      setSession(null);
      setState('anon');
    }
  }, []);

  useEffect(() => {
    // Public pages do not need a session; skip the check to avoid a needless 401.
    if (!isPublic(window.location.pathname)) void refresh();
  }, [refresh]);

  if (isPublic(location.pathname)) {
    return (
      <Routes key={locale}>
        <Route path="/login" element={<Login onLoggedIn={refresh} />} />
        <Route path="/rechtliches" element={<LegalPage />} />
        <Route path="/rechtliches/:name" element={<LegalPage />} />
        <Route path="/passwort" element={<SetPassword />} />
        <Route path="/registrieren" element={<Signup onLoggedIn={refresh} />} />
        <Route path="/beitreten/:code" element={<Join onLoggedIn={refresh} />} />
        <Route path="/mitmachen/:code" element={<ExternalJoin onLoggedIn={refresh} />} />
        <Route path="/statusseite/:slug" element={<FeatureStatusPage />} />
        {/* Public benchmark across workspaces (R3-40) */}
        <Route path="/benchmark" element={<Benchmark />} />
        <Route path="/status" element={<Status />} />
        <Route path="/betrieb" element={<Operator />} />
      </Routes>
    );
  }
  if (state === 'loading') return <main><Loading /></main>;
  if (state === 'anon' && location.pathname === '/') return <Landing key={locale} onLoggedIn={refresh} />;
  if (state === 'anon') return <Navigate to={`/login?weiter=${encodeURIComponent(location.pathname)}`} replace />;
  if (state === 'mfa') return <MfaChallenge onDone={refresh} />;
  if (state === 'mfa-setup') return <MfaSetup onDone={refresh} />;

  return (
    <SessionContext.Provider value={session}>
      {session?.me.user.roles.includes('external') ? <ExternalShell key={getLocale()} /> : <PlanProvider key={getLocale()}><Shell /></PlanProvider>}
    </SessionContext.Provider>
  );
}

function Shell() {
  const { me, refresh, settings } = useSession();
  const [showTour, setShowTour] = useState(!me.onboarded);
  const areas = useAreas();
  const location = useLocation();
  // Close the account menu after navigating.
  useEffect(() => {
    document.querySelectorAll('details.account-menu[open]').forEach((d) => d.removeAttribute('open'));
  }, [location.pathname]);
  const narrow = typeof window !== 'undefined' && window.matchMedia?.('(max-width: 720px)').matches;

  const logout = async () => {
    await api.post('/api/auth/logout');
    window.location.href = me.demo ? '/' : '/login';
  };

  return (
    <>
      <a className="skip-link" href="#inhalt">{t('app.skipToContent')}</a>
      <header className="topbar">
        <Link to="/" className="brand">
          Ideenportal<small>{me.tenant.name}</small>
        </Link>
        <MainNav areas={areas} className="nav" />
        <div className="topbar-right">
          <Link to="/einreichen" className="button primary topbar-submit">{t('app.submitIdea')}</Link>
          <Notifications />
          <details className="menu account-menu">
            <summary className="button" title={t('app.signedInAs', { name: me.user.displayName })}>{t('app.myAccount')}</summary>
            <div className="menu-list">
              <Link to="/konto">{t('app.nav.accountSettings')}</Link>
              <Link to="/hilfe">{t('app.nav.help')}</Link>
              <button type="button" className="link" onClick={logout}>{t('app.logout')}</button>
            </div>
          </details>
        </div>
        <BottomBar areas={areas} />
      </header>
      {me.demo && (
        <aside className="demo-banner" aria-label={t('app.demo')}>
          <details open={!narrow}>
            <summary>
              <strong>{t('app.demo')}</strong> · {t('app.demoSignedIn', { name: me.user.displayName })} <span className="link">{t('app.demoSwitch')}</span>
            </summary>
            <DemoPicker onLoggedIn={refresh} compact />
          </details>
        </aside>
      )}
      <SubNav areas={areas} />
      <PlanBanner />
      <main id="inhalt" tabIndex={-1}>
        <InsightsTabs />
        <TourContext.Provider value={showTour}>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/ideen" element={<Ideas />} />
          <Route path="/ideen/:id" element={<IdeaDetail />} />
          <Route path="/ideen/:id/steckbrief" element={<Steckbrief />} />
          <Route path="/ideen/:id/steckbrief/:tab" element={<Steckbrief />} />
          <Route path="/einreichen" element={<Submit />} />
          <Route path="/einreichen/:id" element={<Submit />} />
          <Route path="/aufgaben" element={<Tasks />} />
          <Route path="/challenges" element={<Challenges />} />
          <Route path="/challenges/:id" element={<ChallengeDetail />} />
          <Route path="/challenges/:id/teams" element={<ChallengeTeams />} />
          <Route path="/nutzen-bestaetigen" element={<BenefitConfirmations />} />
          <Route path="/board" element={<Board />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/radar" element={<Radar />} />
          <Route path="/gremium" element={<Meetings />} />
          <Route path="/gremium/:id" element={<MeetingDetail />} />
          <Route path="/portfolio" element={<Portfolio />} />
          <Route path="/kalibrierung" element={<Calibration />} />
          <Route path="/erfolge" element={<Success />} />
          <Route path="/erfolge/:id/urkunde" element={<Certificate />} />
          <Route path="/einstellungen" element={<Admin />} />
          <Route path="/ki-nachweise" element={<AiProofs />} />
          <Route path="/mitbestimmung" element={<Codetermination />} />
          <Route path="/hilfe" element={<Help />} />
          <Route path="/ki-im-portal" element={<AiTransparency />} />
          <Route path="/konto" element={<Account />} />
          <Route path="/moderation" element={<Moderation />} />
          <Route path="/externe" element={<ExternalAdmin />} />
          <Route path="/wuensche" element={<FeatureRequests />} />
          <Route path="*" element={<p>{t('app.notFound')}</p>} />
        </Routes>
        </TourContext.Provider>
      </main>
      <footer className="app-footer small muted"><Link to="/rechtliches">{t('compliance.footerLink')}</Link> · <Link to="/ki-im-portal">{t('aiTransparency.nav')}</Link></footer>
      {showTour && (
        <Onboarding
          onClose={async () => {
            setShowTour(false);
            await api.post('/api/me/onboarded');
            await refresh();
          }}
        />
      )}
    </>
  );
}
