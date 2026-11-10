import { Link, NavLink, useLocation } from 'react-router-dom';
import { t } from './i18n';
import { hasRole, isStaff, useSession } from './session';

// Navigation by role (usability review 10/2026): three areas instead of one long menu.
// "Entdecken" is for everyone, "Bearbeiten" only with a process role, "Verwaltung" only for
// admins, people admins and the works council. Each area has its own sub navigation.

export type AreaKey = 'explore' | 'work' | 'admin';
interface NavItem {
  to: string;
  label: string;
  /** Further pages that belong to this entry. */
  also?: string[];
}
export interface Area {
  key: AreaKey;
  label: string;
  icon: string;
  items: NavItem[];
}

export function useAreas(): Area[] {
  const { me, settings } = useSession();
  const overview = hasRole(me, 'triage', 'admin', 'committee', 'lead');
  const explore: NavItem[] = [
    { to: '/ideen', label: t('app.nav.ideas') },
    { to: '/challenges', label: t('app.nav.challenges') },
    { to: '/erfolge', label: t('app.nav.success') },
    ...(settings.featureRequests ? [{ to: '/wuensche', label: t('external.nav.features') }] : []),
  ];
  const work: NavItem[] = [
    ...(isStaff(me) ? [{ to: '/aufgaben', label: t('app.nav.tasks') }] : []),
    ...(hasRole(me, 'triage', 'admin', 'committee')
      ? [
          { to: '/board', label: t('app.nav.inbox') },
          { to: '/gremium', label: t('app.nav.committee') },
        ]
      : []),
    ...(overview
      ? [
          { to: '/portfolio', label: t('app.nav.portfolio') },
          { to: '/dashboard', label: t('app.nav.insights'), also: ['/radar'] },
        ]
      : []),
    ...(hasRole(me, 'triage', 'admin') ? [{ to: '/moderation', label: t('external.nav.moderation') }] : []),
    ...(hasRole(me, 'controlling') ? [{ to: '/nutzen-bestaetigen', label: t('usecases.nav.confirm') }] : []),
  ];
  const admin: NavItem[] = [
    ...(hasRole(me, 'admin') ? [{ to: '/einstellungen', label: t('app.nav.settings') }] : []),
    ...(!hasRole(me, 'admin') && hasRole(me, 'user_admin') ? [{ to: '/einstellungen', label: t('ent.nav.people') }] : []),
    ...(hasRole(me, 'admin', 'works_council')
      ? [
          { to: '/ki-nachweise', label: t('app.nav.aiProofs') },
          { to: '/mitbestimmung', label: t('app.nav.codetermination') },
        ]
      : []),
    ...(hasRole(me, 'admin') || (hasRole(me, 'triage') && settings.external) ? [{ to: '/externe', label: t('external.nav.admin') }] : []),
  ];
  return [
    { key: 'explore' as const, label: t('app.nav.explore'), icon: '🔍', items: explore },
    { key: 'work' as const, label: t('app.nav.work'), icon: '🗂️', items: work },
    { key: 'admin' as const, label: t('app.nav.admin'), icon: '⚙️', items: admin },
  ].filter((a) => a.items.length > 0);
}

const inPath = (path: string, to: string) => path === to || path.startsWith(`${to}/`);
const inItem = (path: string, i: NavItem) => [i.to, ...(i.also ?? [])].some((to) => inPath(path, to));

/** The area the current page belongs to; the Steckbrief of an idea belongs to "Entdecken". */
export function currentArea(areas: Area[], path: string): Area | undefined {
  return areas.find((a) => a.items.some((i) => inItem(path, i))) ?? (path === '/kalibrierung' ? areas.find((a) => a.key === 'work') : undefined);
}

/** Top navigation: Start plus one link per area. */
export function MainNav({ areas, className }: { areas: Area[]; className: string }) {
  const { pathname } = useLocation();
  const active = currentArea(areas, pathname);
  return (
    <nav className={className} aria-label={t('app.mainNav')}>
      <NavLink to="/" end>
        {t('app.nav.home')}
      </NavLink>
      {areas.map((a) => (
        <Link key={a.key} to={a.items[0].to} className={active?.key === a.key ? 'active' : undefined} aria-current={active?.key === a.key ? 'page' : undefined}>
          {a.label}
        </Link>
      ))}
    </nav>
  );
}

/** Sub navigation of the current area, as a row of tabs above the page. */
export function SubNav({ areas }: { areas: Area[] }) {
  const { pathname } = useLocation();
  const area = currentArea(areas, pathname);
  if (!area || area.items.length < 2) return null;
  return (
    <nav className="subnav" aria-label={t('app.subNav', { area: area.label })}>
      {area.items.map((i) => (
        <Link key={i.to} to={i.to} className={inItem(pathname, i) ? 'active' : undefined} aria-current={inItem(pathname, i) ? 'page' : undefined}>
          {i.label}
        </Link>
      ))}
    </nav>
  );
}

/** Dashboard and radar are one entry "Auswertungen" with two tabs. */
export function InsightsTabs() {
  const { pathname } = useLocation();
  if (pathname !== '/dashboard' && pathname !== '/radar') return null;
  return (
    <nav className="tabs page-tabs" aria-label={t('app.nav.insights')}>
      <NavLink to="/dashboard">{t('app.nav.dashboard')}</NavLink>
      <NavLink to="/radar">{t('radar.nav')}</NavLink>
    </nav>
  );
}

/** Bottom bar on phones: the core tasks within thumb reach. */
export function BottomBar({ areas }: { areas: Area[] }) {
  const { pathname } = useLocation();
  const active = currentArea(areas, pathname);
  return (
    <nav className="bottombar" aria-label={t('app.mobileNav')}>
      <NavLink to="/" end>
        <span aria-hidden="true">🏠</span>
        {t('app.nav.home')}
      </NavLink>
      {areas.map((a) => (
        <Link key={a.key} to={a.items[0].to} className={active?.key === a.key ? 'active' : undefined} aria-current={active?.key === a.key ? 'page' : undefined}>
          <span aria-hidden="true">{a.icon}</span>
          {a.label}
        </Link>
      ))}
      <NavLink to="/einreichen" className="bottombar-submit">
        <span aria-hidden="true">＋</span>
        {t('app.nav.submitShort')}
      </NavLink>
      <NavLink to="/konto">
        <span aria-hidden="true">👤</span>
        {t('app.nav.account')}
      </NavLink>
    </nav>
  );
}
