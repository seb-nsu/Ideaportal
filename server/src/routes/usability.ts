import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tenantHandler } from '../http.js';
import { guaranteeQuota } from '../services/guarantee.js';

// Usability from the click test (AP-07): response guarantee on the start page (R1-46), first start
// per role and screen and the "first week" checklist under "Meine Aufgaben" (R2-48).

export const INTRO_SCREENS = ['board', 'steckbrief', 'gremium'] as const;
const itemId = z.string().regex(/^[a-z0-9_]{1,40}$/);

export async function usabilityRoutes(app: FastifyInstance): Promise<void> {
  // Everyone in the workspace sees the promise and how well it is kept: aggregated counts only.
  app.get('/api/guarantee', tenantHandler(async (ctx) => guaranteeQuota(ctx)));

  app.get(
    '/api/me/onboarding',
    tenantHandler(async (ctx) => {
      const r = await ctx.db.query<{ intros_seen: string[]; first_week_done: string[]; first_week_hidden: boolean }>(
        'SELECT intros_seen, first_week_done, first_week_hidden FROM users WHERE id = $1',
        [ctx.user!.id],
      );
      const u = r.rows[0];
      return { introsSeen: u.intros_seen, firstWeek: { done: u.first_week_done, hidden: u.first_week_hidden } };
    }),
  );

  // Remembered per person and screen; skipping counts as seen.
  app.post(
    '/api/me/onboarding/intro',
    tenantHandler(async (ctx, req) => {
      const { screen } = z.object({ screen: z.enum(INTRO_SCREENS) }).parse(req.body);
      await ctx.db.query(
        'UPDATE users SET intros_seen = array_append(intros_seen, $2) WHERE id = $1 AND NOT ($2 = ANY(intros_seen))',
        [ctx.user!.id, screen],
      );
      return { ok: true };
    }),
  );

  // Showing the steps again: the person can reset the remembered screens.
  app.delete(
    '/api/me/onboarding/intro',
    tenantHandler(async (ctx) => {
      await ctx.db.query(`UPDATE users SET intros_seen = '{}' WHERE id = $1`, [ctx.user!.id]);
      return { ok: true };
    }),
  );

  app.put(
    '/api/me/onboarding/first-week',
    tenantHandler(async (ctx, req) => {
      const body = z.object({ done: z.array(itemId).max(30), hidden: z.boolean() }).parse(req.body);
      await ctx.db.query('UPDATE users SET first_week_done = $2, first_week_hidden = $3 WHERE id = $1', [ctx.user!.id, [...new Set(body.done)], body.hidden]);
      return { ok: true };
    }),
  );
}
