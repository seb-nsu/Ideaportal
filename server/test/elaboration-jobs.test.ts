import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, withTenant } from '../src/db/pool.js';
import { runTenantJobs } from '../src/jobs/deadlines.js';
import type { SessionUser } from '../src/lib/context.js';
import { addMeetingItem, createExperiment, createMeeting, recordExperimentResult } from '../src/services/elaboration.js';
import {
  closeImplementation,
  createIdea,
  decideGate2,
  ideaInput,
  loadIdea,
  submitIdea,
  triageIdea,
} from '../src/services/workflow.js';
import { asUser, createTenant, createUser, resetDb, validIdea } from './helpers.js';

// Release 2 deadlines with a simulated "today": timebox reminder (R2-01), meeting pack (R2-04),
// experiment reminder (R2-06) and impact review due date (R2-07).

let tenant: string;
let author: SessionUser;
let triage: SessionUser;
let committee: SessionUser;
let mentor: SessionUser;
let owner: SessionUser;
const start = '2026-10-12'; // Monday

beforeAll(async () => {
  await resetDb();
  tenant = await createTenant('r2-jobs', { holidays: [] });
  author = await createUser(tenant, 'author@rj.example');
  triage = await createUser(tenant, 'triage@rj.example', ['submitter', 'triage']);
  committee = await createUser(tenant, 'committee@rj.example', ['submitter', 'committee']);
  mentor = await createUser(tenant, 'mentor@rj.example', ['submitter', 'mentor']);
  owner = await createUser(tenant, 'owner@rj.example', ['submitter', 'implementer']);
});

afterAll(() => closePool());

const run = async (day: string) => (await asUser(null, tenant, (ctx) => runTenantJobs(ctx), day)).elaboration!;

async function inElaboration(title: string, timeboxUntil?: string): Promise<string> {
  const id = await asUser(author, tenant, async (ctx) => {
    const idea = await createIdea(ctx, ideaInput.parse({ ...validIdea, title }));
    await submitIdea(ctx, await loadIdea(ctx, idea.id, true), { confirmNotReport: true, boundaryAcknowledged: true });
    return idea.id;
  }, start);
  await asUser(triage, tenant, async (ctx) => triageIdea(ctx, await loadIdea(ctx, id, true), { lane: 'elaborate', mentorId: mentor.id, timeboxUntil }), start);
  return id;
}

async function inbox(user: SessionUser, subject: string): Promise<number> {
  const r = await withTenant(tenant, (db) => db.query('SELECT count(*)::int AS n FROM outbox WHERE user_id = $1 AND subject LIKE $2', [user.id, `${subject}%`]));
  return r.rows[0].n;
}

describe('Release 2 deadline jobs', () => {
  it('reminds the mentor before the timebox ends and reports when it is exceeded', async () => {
    await inElaboration('Timebox-Test', '2026-10-30'); // Friday
    expect((await run('2026-10-27')).timeboxReminders).toBe(0); // 3 working days left
    expect((await run('2026-10-28')).timeboxReminders).toBe(1);
    expect((await run('2026-10-29')).timeboxReminders).toBe(0);
    expect(await inbox(mentor, 'Erinnerung: Timebox')).toBe(1);
    expect((await run('2026-10-30')).timeboxExceeded).toBe(0);
    expect((await run('2026-10-31')).timeboxExceeded).toBe(1);
    expect((await run('2026-11-02')).timeboxExceeded).toBe(0);
    expect(await inbox(mentor, 'Timebox überschritten')).toBe(1);
    expect(await inbox(triage, 'Timebox überschritten')).toBe(1);
  });

  it('sends the meeting pack five working days before the meeting', async () => {
    const id = await inElaboration('Sitzungs-Test');
    const meeting = await asUser(triage, tenant, (ctx) => createMeeting(ctx, { title: 'Gremium November', meetsOn: '2026-11-20' }), start);
    expect(meeting.packDueOn).toBe('2026-11-13');
    await asUser(triage, tenant, (ctx) => addMeetingItem(ctx, meeting.id, id), start);
    expect((await run('2026-11-12')).meetingPacks).toBe(0);
    expect((await run('2026-11-13')).meetingPacks).toBe(1);
    expect((await run('2026-11-16')).meetingPacks).toBe(0);
    expect(await inbox(committee, 'Unterlagen für die Gremiumssitzung')).toBe(1);
    const m = await withTenant(tenant, (db) => db.query('SELECT status FROM meetings WHERE id = $1', [meeting.id]));
    expect(m.rows[0].status).toBe('sent');
  });

  it('reminds two working days before an experiment ends', async () => {
    const id = await inElaboration('Experiment-Test');
    await asUser(mentor, tenant, async (ctx) =>
      createExperiment(ctx, await loadIdea(ctx, id), {
        hypothesis: 'Die Hypothese hält.', smallestTest: 'Test', metric: 'Quote', successCriteria: '>= 50 %', startsOn: start, endsOn: '2026-11-10',
      }), start);
    expect((await run('2026-11-05')).experimentReminders).toBe(0);
    expect((await run('2026-11-06')).experimentReminders).toBe(1);
    expect((await run('2026-11-09')).experimentReminders).toBe(0);
    expect(await inbox(mentor, 'Experiment endet bald')).toBe(1);
  });

  it('creates the impact review task on its due date', async () => {
    const id = await inElaboration('Wirkungs-Test');
    await asUser(committee, tenant, async (ctx) =>
      decideGate2(ctx, await loadIdea(ctx, id, true), { outcome: 'implement', reason: 'Guter Business Case.', ownerId: owner.id, targetDate: '2026-12-01' }), start);
    await asUser(owner, tenant, async (ctx) =>
      closeImplementation(ctx, await loadIdea(ctx, id, true), { benefitKind: 'euro', benefitValue: 5000, benefitEvidence: 'Rechnung der Haustechnik.' }), start);
    const review = await withTenant(tenant, (db) => db.query('SELECT due_on, reviewer_id FROM impact_reviews WHERE idea_id = $1', [id]));
    expect(review.rows[0]).toEqual({ due_on: '2027-01-12', reviewer_id: mentor.id });
    expect((await run('2027-01-11')).impactReviewsDue).toBe(0);
    expect((await run('2027-01-12')).impactReviewsDue).toBe(1);
    expect((await run('2027-01-13')).impactReviewsDue).toBe(0);
    expect(await inbox(mentor, 'Wirkungsreview fällig')).toBe(1);
  });

  it('does not remind owners of implementations that went back to Gate 2', async () => {
    const id = await inElaboration('Rückkehr-Test');
    await asUser(committee, tenant, async (ctx) =>
      decideGate2(ctx, await loadIdea(ctx, id, true), { outcome: 'pilot', reason: 'Erst erproben.', ownerId: owner.id, targetDate: '2026-10-20' }), start);
    const exp = await asUser(owner, tenant, async (ctx) =>
      createExperiment(ctx, await loadIdea(ctx, id), { hypothesis: 'Pilot klappt.', smallestTest: '', metric: 'Quote', successCriteria: '', startsOn: start, endsOn: '2026-10-16' }), start);
    await asUser(owner, tenant, async (ctx) =>
      recordExperimentResult(ctx, await loadIdea(ctx, id, true), exp.id, { outcome: 'inconclusive', result: 'Zu wenige Daten im Pilot.' }), '2026-10-16');
    const r = await asUser(null, tenant, (ctx) => runTenantJobs(ctx), '2026-10-21');
    const reminded = await withTenant(tenant, (db) => db.query('SELECT overdue_reminded_at FROM implementations WHERE idea_id = $1', [id]));
    expect(reminded.rows[0].overdue_reminded_at).toBeNull();
    expect(r.overdueImplementations).toBe(0);
  });
});
