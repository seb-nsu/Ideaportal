import type { Ctx } from '../lib/context.js';
import { hasFeature } from './billing.js';

// Feature requests (R3-20) are a module for existing customers with product teams: the package
// must include it (feature switch 'featureRequests' of AP-18) and the tenant switches it on
// (setting featureRequests.enabled, default off).

export const FEATURE_STATUSES = ['new', 'planned', 'in_progress', 'done', 'declined'] as const;
export type FeatureStatus = (typeof FEATURE_STATUSES)[number];

export function featureRequestsOn(ctx: Pick<Ctx, 'settings' | 'plan'>): boolean {
  return ctx.settings.featureRequests.enabled && hasFeature(ctx, 'featureRequests');
}
