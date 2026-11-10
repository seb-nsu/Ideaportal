import { createContext, useContext, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useLoad } from './components';
import { formatDate, t, tn } from './i18n';
import { useSession, hasRole } from './session';

// Package of the workspace (R3-05, R3-02, R3-39): feature switches for hiding unavailable
// features with an upgrade hint, and the banner for trial, read-only mode and challenge package.

export const FEATURES = ['api', 'webhooks', 'sso', 'scim', 'chat', 'connectors', 'externalParticipation', 'featureRequests', 'crowdRating', 'moduleZ'] as const;
export type Feature = (typeof FEATURES)[number];

export interface PlanInfo {
  plan: 'internal' | 'trial' | 'team' | 'business_1000' | 'business_2500' | 'enterprise' | 'challenge';
  status: 'trial' | 'active' | 'read_only' | 'ended';
  readOnly: boolean;
  features: Partial<Record<Feature, boolean>>;
  trialEndsOn: string | null;
  trialDaysLeft: number | null;
  endsOn: string | null;
  daysLeft: number | null;
}

const PlanContext = createContext<PlanInfo | null>(null);

export function PlanProvider({ children }: { children: ReactNode }) {
  const { data } = useLoad<PlanInfo>('/api/plan');
  return <PlanContext.Provider value={data ?? null}>{children}</PlanContext.Provider>;
}

export function usePlan(): PlanInfo | null {
  return useContext(PlanContext);
}

/** True while the package is unknown, so nothing flickers away while it loads. */
export function useFeature(feature: Feature): boolean {
  const plan = usePlan();
  return plan?.features[feature] ?? true;
}

/** Shown instead of a feature the package does not include. */
export function UpgradeHint({ feature }: { feature: Feature }) {
  const { me } = useSession();
  return (
    <div className="card" role="note">
      <h2 style={{ marginTop: 0 }}>{t('billing.upgrade.heading', { feature: t(`billing.feature.${feature}`) })}</h2>
      <p style={{ marginBottom: 0 }}>
        {t('billing.upgrade.text')}{' '}
        {hasRole(me, 'admin') ? t('billing.upgrade.admin') : t('billing.upgrade.member')}
      </p>
    </div>
  );
}

/** Trial days, read-only mode and the end of the challenge package, below the top bar. */
export function PlanBanner() {
  const plan = usePlan();
  const { me } = useSession();
  if (!plan) return null;
  const admin = hasRole(me, 'admin');
  let text: string | null = null;
  let tone = 'info';
  if (plan.readOnly) {
    text = plan.plan === 'challenge' ? t('billing.banner.challengeEnded') : t('billing.banner.readOnly');
    tone = 'warn';
  } else if (plan.plan === 'trial' && plan.trialDaysLeft != null) {
    text = tn('billing.banner.trial', plan.trialDaysLeft, { date: formatDate(plan.trialEndsOn) });
    if (plan.trialDaysLeft <= 7) tone = 'warn';
  } else if (plan.plan === 'challenge' && plan.daysLeft != null) {
    text = tn('billing.banner.challenge', plan.daysLeft, { date: formatDate(plan.endsOn) });
  }
  if (!text) return null;
  return (
    <aside className={`plan-banner ${tone}`} aria-label={t('billing.banner.label')}>
      <span>{text}</span>
      {admin && <Link to="/einstellungen?tab=plan">{t('billing.banner.action')}</Link>}
    </aside>
  );
}
