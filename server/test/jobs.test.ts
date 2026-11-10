import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, withTenant } from '../src/db/pool.js';
import { runTenantJobs } from '../src/jobs/deadlines.js';
import type { SessionUser } from '../src/lib/context.js';
import { addWorkdays } from '../src/lib/workdays.js';
import { answerQuestion, askQuestion, createIdea, decideGate2, ideaInput, loadIdea, submitIdea, triageIdea } from '../src/services/workflow.js';
import { asUser, createTenant, createUser, resetDb, validIdea } from './helpers.js';

// Reminders and escalation (R1-26), closing unanswered questions, resubmission of parked ideas (R1-33).
// The jobs run with a simulated "today" so that deadlines can be tested deterministically.

let tenant: string;
let author: SessionUser;
let triage: SessionUser;
let committee: SessionUser;
let admin: SessionUser;
const noHolidays = { holidays: [] };
const start = '2026-10-12'; // Monday

beforeAll(async () => {
  await resetDb();
  tenant = await createTenant('jobs', noHolidays);
  author = await createUser(tenant, 'author@j.example');
  triage = await createUser(tenant, 'triage@j.example', ['submitter', 'triage']);
  committee = await createUser(tenant, 'committee@j.example', ['submitter', 'committee']);
  admin = await createUser(tenant, 'admin@j.example', ['submitter', 'admin']);
});

afterAll(() => closePool());

async function submitOn(day: string, title: string): Promise<string> {
  return asUser(author, tenant, async (ctx) => {
    const idea = await createIdea(ctx, ideaInput.parse({ ...validIdea, title }));
    await submitIdea(ctx, await loadIdea(ctx, idea.id, true), { confirmNotReport: true });
    return idea.id;
  }, day);
}

const run = (day: string) => asUser(null, tenant, (ctx) => runTenantJobs(ctx), day);

async function inbox(user: SessionUser, subject: string): Promise<number> {
  const r = await withTenant(tenant, (db) => db.query('SELECT count(*)::int AS n FROM outbox WHERE user_id = $1 AND subject LIKE $2', [user.id, `${subject}%`]));
  return r.rows[0].n;
}

describe('deadline jobs', () => {
  it('reminds two working days before and escalates once when overdue', async () => {
    const id = await submitOn(start, 'Fristtest');
    // Due after 10 working days: 2026-10-26
    expect((await run('2026-10-21')).reminders).toBe(0);
    expect((await run('2026-10-22')).reminders).toBe(1);
    expect((await run('2026-10-23')).reminders).toBe(0); // only once
    expect(await inbox(triage, 'Erinnerung')).toBe(1);
    expect((await run('2026-10-26')).escalations).toBe(0);
    expect((await run('2026-10-27')).escalations).toBe(1);
    expect((await run('2026-10-28')).escalations).toBe(0);
    expect(await inbox(admin, 'Frist überschritten')).toBe(1);
    const events = await withTenant(tenant, (db) => db.query(`SELECT kind FROM idea_events WHERE idea_id = $1`, [id]));
    expect(events.rows.map((e) => e.kind)).toContain('escalation');
  });

  it('extends the deadline by the paused working days', async () => {
    const id = await submitOn(start, 'Pausentest');
    await asUser(triage, tenant, async (ctx) => askQuestion(ctx, await loadIdea(ctx, id, true), 'Bitte ergänzen?'), '2026-10-14');
    // Paused: no reminder or escalation while waiting for the answer.
    expect((await run('2026-10-30')).escalations).toBe(0); // the paused idea is not escalated
    await asUser(author, tenant, async (ctx) => {
      await answerQuestion(ctx, await loadIdea(ctx, id, true), 'Ergänzt.');
    }, '2026-10-21'); // 5 working days paused
    const due = await withTenant(tenant, (db) => db.query(`SELECT due_on FROM deadlines WHERE idea_id = $1`, [id]));
    expect(due.rows[0].due_on).toBe(addWorkdays('2026-10-26', 5, new Set()));
  });

  it('closes an idea after 15 working days without an answer', async () => {
    const id = await submitOn(start, 'Ohne Antwort');
    await asUser(triage, tenant, async (ctx) => askQuestion(ctx, await loadIdea(ctx, id, true), 'Wer ist betroffen?'), start);
    expect((await run(addWorkdays(start, 14, new Set()))).closed).toBe(0);
    expect((await run(addWorkdays(start, 15, new Set()))).closed).toBe(1);
    const idea = await withTenant(tenant, (db) => db.query('SELECT status FROM ideas WHERE id = $1', [id]));
    expect(idea.rows[0].status).toBe('closed_no_answer');
    expect(await inbox(author, 'Idee geschlossen')).toBe(1);
  });

  it('returns parked ideas on the resubmission date', async () => {
    const id = await submitOn(start, 'Parktest');
    await asUser(triage, tenant, async (ctx) => triageIdea(ctx, await loadIdea(ctx, id, true), { lane: 'elaborate' }), start);
    await asUser(committee, tenant, async (ctx) =>
      decideGate2(ctx, await loadIdea(ctx, id, true), { outcome: 'park', reason: 'Wiedervorlage im Frühjahr.', resubmitOn: '2026-12-01' }), start);
    expect((await run('2026-11-30')).resubmitted).toBe(0);
    expect((await run('2026-12-01')).resubmitted).toBe(1);
    const idea = await withTenant(tenant, (db) => db.query('SELECT status, resubmit_on FROM ideas WHERE id = $1', [id]));
    expect(idea.rows[0]).toEqual({ status: 'elaboration', resubmit_on: null });
    expect(await inbox(committee, 'Wiedervorlage')).toBe(1);
  });

  it('reminds owners of overdue implementations once', async () => {
    const id = await submitOn(start, 'Umsetzung im Verzug');
    await asUser(triage, tenant, async (ctx) =>
      triageIdea(ctx, await loadIdea(ctx, id, true), { lane: 'fast_lane', ownerId: admin.id, orgUnit: 'Technik', targetDate: '2026-11-02' }), start);
    expect((await run('2026-11-02')).overdueImplementations).toBe(0);
    expect((await run('2026-11-03')).overdueImplementations).toBe(1);
    expect((await run('2026-11-04')).overdueImplementations).toBe(0);
  });

  it('delivers queued mails', async () => {
    const r = await run('2026-12-02');
    expect(r.mailsSent).toBe(0); // everything was delivered by the earlier runs
    const pending = await withTenant(tenant, (db) => db.query('SELECT count(*)::int AS n FROM outbox WHERE sent_at IS NULL'));
    expect(pending.rows[0].n).toBe(0);
  });
});
