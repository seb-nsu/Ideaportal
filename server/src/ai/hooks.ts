import type { Ctx } from '../lib/context.js';

// Workflow hooks that queue AI work. They only insert jobs, so the idea flow never waits
// for a model and never fails because of one.

export async function enqueueAiJob(ctx: Ctx, kind: string, ideaId: string | null, params: Record<string, unknown> = {}): Promise<void> {
  if (!ctx.settings.ai.enabled) return;
  await ctx.db.query(
    `INSERT INTO ai_jobs (tenant_id, idea_id, kind, params, created_by) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT DO NOTHING`,
    [ctx.tenantId, ideaId, kind, JSON.stringify(params), ctx.user?.id ?? null],
  );
}

/** After submission: short analysis for every idea (R2-22) and triage suggestion (R2-18). */
export async function onIdeaSubmitted(ctx: Ctx, ideaId: string): Promise<void> {
  if (ctx.settings.ai.autoShortAnalysis) await enqueueAiJob(ctx, 'short_analysis', ideaId);
}

/** Lane "elaborate" at Gate 1: full analysis (R2-22) followed by the dossier draft (R2-31). */
export async function onElaborationStarted(ctx: Ctx, ideaId: string): Promise<void> {
  if (ctx.settings.ai.autoFullAnalysis) await enqueueAiJob(ctx, 'full_analysis', ideaId);
}
