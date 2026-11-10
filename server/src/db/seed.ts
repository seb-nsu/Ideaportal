import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCtx, type SessionUser } from '../lib/context.js';
import { hashPassword } from '../lib/crypto.js';
import { addWorkdays } from '../lib/workdays.js';
import {
  acceptImplementation,
  closeImplementation,
  createIdea,
  loadIdea,
  submitIdea,
  triageIdea,
} from '../services/workflow.js';
import { addMeetingItem, createMeeting, rateGate2, saveDossierSection, updateEstimates } from '../services/elaboration.js';
import { approveStory, sendStoryToAuthor, upsertSuccessStoryDraft } from '../services/recognition.js';
import { closePool, withSystem, withTenant } from './pool.js';
import { migrate } from './migrate.js';
import { drainAiJobs } from '../ai/worker.js';
import { addDemoResults } from './demo-results.js';
import { DEMO_CONTENT, DEMO_WORKSPACES, type DemoIdeaText } from './demo-content.js';
import { LOCALES, type Locale } from '../i18n/index.js';
import { localizedDefaults } from '../lib/default-texts.js';

const ideaText = (t: DemoIdeaText) => ({ title: t.title, problem: t.problem, solution: t.solution, benefit: t.benefit, topic: t.topic });

// Demo data for development and the staging environment: two tenants, one user per role,
// three example ideas (R1-38) and a challenge. Never run against production.

export const DEMO_PASSWORD = 'Ideenportal-Demo-2026';

async function seedTenant(slug: string, name: string, domain: string, extraSettings: Record<string, unknown>, createdVia = 'admin', locale: Locale = 'de'): Promise<boolean> {
  const d = DEMO_CONTENT[locale];
  const tenantId = await withSystem(async (c) => {
    const exists = await c.query('SELECT 1 FROM tenants WHERE slug = $1', [slug]);
    if (exists.rowCount) return null;
    const settings = {
      ...localizedDefaults(locale),
      targetChannels: d.channels.map((ch) => ({ id: ch.id, name: ch.name, kind: ch.kind, contact: `${ch.local}@${domain}`, url: ch.withUrl ? `https://${ch.local}.${domain}` : '' })),
      ...extraSettings,
    };
    return (await c.query<{ id: string }>('INSERT INTO tenants (slug, name, settings, created_via) VALUES ($1, $2, $3, $4) RETURNING id', [slug, name, JSON.stringify(settings), createdVia])).rows[0].id;
  });
  if (!tenantId) return false;

  const hash = await hashPassword(DEMO_PASSWORD);
  const users: Record<string, SessionUser> = {};
  await withTenant(tenantId, async (db) => {
    for (const p of d.people) {
      const email = `${p.local}@${domain}`;
      const id = (await db.query<{ id: string }>(
        `INSERT INTO users (tenant_id, email, display_name, org_unit, roles, password_hash, onboarded) VALUES ($1, $2, $3, $4, $5, $6, false) RETURNING id`,
        [tenantId, email, p.name, p.orgUnit, p.roles, hash],
      )).rows[0].id;
      users[p.key] = { id, tenantId, email, displayName: p.name, orgUnit: p.orgUnit, roles: p.roles, mfaEnabled: false };
    }
  });

  const as = <T>(key: string, fn: (ctx: Awaited<ReturnType<typeof buildCtx>>) => Promise<T>) =>
    withTenant(tenantId, async (db) => fn(await buildCtx(db, tenantId, users[key])));

  const challengeId = await as('admin', async (ctx) => {
    const end = addWorkdays(ctx.today, 30, ctx.holidays);
    // Own fields, teams and a jury (R2-35).
    const fields = d.challenge.fields.map((f) => ({ ...f, required: false }));
    const id = (await ctx.db.query<{ id: string }>(
      `INSERT INTO challenges (tenant_id, title, question, topic, contact, sponsor_id, starts_on, ends_on, custom_fields, teams_allowed)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true) RETURNING id`,
      [tenantId, d.challenge.title, d.challenge.question, d.challenge.topic, users.admin.displayName, users.admin.id, ctx.today, end, JSON.stringify(fields)],
    )).rows[0].id;
    for (const juror of [users.committee.id, users.mentor.id]) {
      await ctx.db.query('INSERT INTO challenge_jury (tenant_id, challenge_id, user_id) VALUES ($1, $2, $3)', [tenantId, id, juror]);
    }
    return id;
  });

  // Example 1: freshly submitted idea, waiting for triage.
  await as('submitter', async (ctx) => {
    const idea = await createIdea(ctx, {
      ...ideaText(d.holiday), ideaType: 'internal', confidential: false, anonymous: false, challengeId,
    });
    await submitIdea(ctx, await loadIdea(ctx, idea.id, true), { confirmNotReport: true });
  });

  // Example 2: product idea in elaboration, waiting for Gate 2.
  const second = await as('mentor', async (ctx) => {
    const idea = await createIdea(ctx, {
      ...ideaText(d.portal), ideaType: 'product', confidential: false, anonymous: false, challengeId: null,
    });
    await submitIdea(ctx, await loadIdea(ctx, idea.id, true), { confirmNotReport: true });
    return idea.id;
  });
  await as('triage', async (ctx) =>
    triageIdea(ctx, await loadIdea(ctx, second, true), { lane: 'elaborate', reason: d.portal.triageReason, mentorId: users.mentor.id }));
  // Dossier, estimates and a rating (R2-02, R2-03) and a committee meeting (R2-04).
  await as('mentor', async (ctx) => {
    const idea = await loadIdea(ctx, second, true);
    await saveDossierSection(ctx, idea, 'summary', d.portal.dossier.summary, { source: 'human' });
    await saveDossierSection(ctx, idea, 'benefit', d.portal.dossier.benefit, { source: 'human', openPoints: [d.portal.dossier.benefitOpen] });
    await saveDossierSection(ctx, idea, 'effort', d.portal.dossier.effort, { source: 'human' });
    await saveDossierSection(ctx, idea, 'risks', d.portal.dossier.risks, { source: 'human' });
    await updateEstimates(ctx, idea, { horizon: 2, effortPersonDays: 60, effortEuro: 45000, planBenefitEuro: 120000 });
    await rateGate2(ctx, idea, { scores: { strategic_fit: 4, user_value: 5, economic_value: 4, feasibility: 3, risk: 3 } });
  });
  await as('triage', async (ctx) => {
    const meeting = await createMeeting(ctx, { title: d.portal.meeting, meetsOn: addWorkdays(ctx.today, 15, ctx.holidays) });
    await addMeetingItem(ctx, meeting.id, second);
  });

  // Example 3: implemented idea with actual benefit.
  const third = await as('submitter', async (ctx) => {
    const idea = await createIdea(ctx, {
      ...ideaText(d.light), ideaType: 'internal', confidential: false, anonymous: false, challengeId: null,
    });
    await submitIdea(ctx, await loadIdea(ctx, idea.id, true), { confirmNotReport: true });
    return idea.id;
  });
  await as('triage', async (ctx) => {
    const target = addWorkdays(ctx.today, 20, ctx.holidays);
    await triageIdea(ctx, await loadIdea(ctx, third, true), {
      lane: 'fast_lane', reason: d.light.triageReason, ownerId: users.owner.id, orgUnit: d.light.orgUnit, targetDate: target,
    });
  });
  await as('owner', async (ctx) => acceptImplementation(ctx, await loadIdea(ctx, third, true)));
  await as('owner', async (ctx) =>
    closeImplementation(ctx, await loadIdea(ctx, third, true), {
      benefitKind: 'euro', benefitValue: 3200, benefitEvidence: d.light.evidence,
    }),
  );
  // Published success story (R2-37, R2-38).
  await as('admin', async (ctx) => {
    await upsertSuccessStoryDraft(ctx, third, d.light.storyTitle, d.light.storyBody, null);
    await sendStoryToAuthor(ctx, await loadIdea(ctx, third, true));
  });
  await as('submitter', async (ctx) => approveStory(ctx, await loadIdea(ctx, third, true), true));
  // The public demo shows pre-generated analyses instead of builtin drafts (R2-40).
  if (createdVia === 'demo') await withTenant(tenantId, (db) => addDemoResults(db, tenantId, locale));

  return true;
}

/** Creates the shared demo workspaces if they are missing. Admins need no MFA so the demo works without an authenticator app. */
export async function ensureDemoTenant(): Promise<boolean> {
  let created = false;
  for (const locale of LOCALES) {
    const w = DEMO_WORKSPACES[locale];
    if (await seedTenant(w.slug, w.name, w.domain, { requireMfaForAdmins: false }, 'demo', locale)) created = true;
  }
  return created;
}

export async function seed(log: (msg: string) => void = console.log): Promise<void> {
  await migrate(log);
  if (await ensureDemoTenant()) log('demo workspaces created');
  if (await seedTenant('beispiel', 'Beispiel GmbH', 'beispiel.example', {})) log('tenant "beispiel" created');
  // Built-in AI: quality check, short and full analyses of the example ideas.
  log(`AI jobs processed: ${await drainAiJobs()}`);
  log(`demo password for all users: ${DEMO_PASSWORD}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  seed()
    .then(() => closePool())
    .catch(async (err) => {
      console.error(err);
      await closePool();
      process.exit(1);
    });
}
