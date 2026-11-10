import { randomBytes } from 'node:crypto';
import { withSystem, type Db } from '../db/pool.js';
import { base32Encode, hashPassword, verifyPassword } from '../lib/crypto.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { m } from '../i18n/index.js';
import { OPERATOR_ROLES, operatorLog, sealOperatorTotp, type Operator, type OperatorRole } from './operator.js';

// Individual operator accounts (enterprise). Platform data without tenant: owner connection
// only. Every account has a password (scrypt) and a mandatory TOTP secret. New accounts and
// reset accounts get a random start password that must be changed at the first login.

export const MIN_OPERATOR_PASSWORD = 12;

export interface OperatorAccountView {
  id: string;
  email: string;
  name: string;
  role: OperatorRole;
  active: boolean;
  mustChangePassword: boolean;
  locked: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  createdBy: string | null;
}

export interface NewCredentials {
  id: string;
  /** Shown once; hand it over on a separate channel. */
  password: string;
  totpSecret: string;
  otpauthUrl: string;
}

function credentials(email: string) {
  const password = randomBytes(15).toString('base64url');
  const totpSecret = base32Encode(randomBytes(20));
  const label = encodeURIComponent('Ideenportal Betrieb');
  return { password, totpSecret, otpauthUrl: `otpauth://totp/${label}:${encodeURIComponent(email)}?secret=${totpSecret}&issuer=${label}` };
}

const by = (op: Operator | string) => (typeof op === 'string' ? op : op.name);

export async function listOperators(): Promise<OperatorAccountView[]> {
  return withSystem(
    async (c) =>
      (
        await c.query<OperatorAccountView>(
          `SELECT id, email, name, role, active, must_change_password AS "mustChangePassword", coalesce(locked_until > now(), false) AS locked,
            last_login_at AS "lastLoginAt", created_at AS "createdAt", created_by AS "createdBy"
       FROM operator_accounts ORDER BY active DESC, name`,
        )
      ).rows,
  );
}

/** Creates an account; returns the start password and the TOTP secret once. */
export async function createOperator(actor: Operator | string, input: { email: string; name: string; role: OperatorRole }, db?: Db): Promise<NewCredentials> {
  if (!OPERATOR_ROLES.includes(input.role)) throw badRequest(m('opadmin.roleUnknown'));
  const run = async (c: Db) => {
    if ((await c.query('SELECT 1 FROM operator_accounts WHERE lower(email) = lower($1)', [input.email.trim()])).rowCount)
      throw conflict(m('opadmin.emailTaken'));
    const cred = credentials(input.email.trim());
    const id = (
      await c.query<{ id: string }>(
        `INSERT INTO operator_accounts (email, name, password_hash, totp_secret, role, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [input.email.trim(), input.name.trim(), await hashPassword(cred.password), sealOperatorTotp(cred.totpSecret), input.role, by(actor)],
      )
    ).rows[0].id;
    await operatorLog(c, actor, 'operator.create', null, { id, email: input.email.trim(), role: input.role });
    return { id, ...cred };
  };
  return db ? run(db) : withSystem(run);
}

async function assertOwnerRemains(c: Db, id: string) {
  const r = await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM operator_accounts WHERE active AND role = 'owner' AND id <> $1`, [id]);
  if (r.rows[0].n === 0) throw badRequest(m('opadmin.lastOwner'));
}

/** Role, name or active flag; an owner cannot change their own role or deactivate themselves. */
export async function updateOperator(actor: Operator, id: string, input: { role?: OperatorRole; active?: boolean; name?: string }): Promise<void> {
  await withSystem(async (c) => {
    const before = (
      await c.query<{ role: OperatorRole; active: boolean; name: string }>('SELECT role, active, name FROM operator_accounts WHERE id = $1 FOR UPDATE', [id])
    ).rows[0];
    if (!before) throw notFound(m('opadmin.notFound'));
    if (actor.id === id && ((input.role && input.role !== before.role) || input.active === false)) throw badRequest(m('opadmin.ownAccount'));
    const after = { role: input.role ?? before.role, active: input.active ?? before.active, name: input.name?.trim() || before.name };
    if (before.role === 'owner' && before.active && (after.role !== 'owner' || !after.active)) await assertOwnerRemains(c, id);
    await c.query('UPDATE operator_accounts SET role = $2, active = $3, name = $4, updated_at = now() WHERE id = $1', [
      id,
      after.role,
      after.active,
      after.name,
    ]);
    if (!after.active || after.role !== before.role) await c.query('DELETE FROM operator_sessions WHERE operator_id = $1', [id]);
    await operatorLog(c, actor, 'operator.update', null, { id, before, after });
  });
}

/** New start password and TOTP secret (lost phone, forgotten password); ends the sessions. */
export async function resetOperator(actor: Operator | string, id: string, db?: Db): Promise<NewCredentials> {
  const run = async (c: Db) => {
    const acc = (await c.query<{ email: string }>('SELECT email FROM operator_accounts WHERE id = $1', [id])).rows[0];
    if (!acc) throw notFound(m('opadmin.notFound'));
    const cred = credentials(acc.email);
    await c.query(
      `UPDATE operator_accounts SET password_hash = $2, totp_secret = $3, must_change_password = true, failed_logins = 0, locked_until = NULL, updated_at = now() WHERE id = $1`,
      [id, await hashPassword(cred.password), sealOperatorTotp(cred.totpSecret)],
    );
    await c.query('DELETE FROM operator_sessions WHERE operator_id = $1', [id]);
    await operatorLog(c, actor, 'operator.reset', null, { id });
    return { id, ...cred };
  };
  return db ? run(db) : withSystem(run);
}

/** Own password; needed after the first login and after a reset. */
export async function changeOwnPassword(op: Operator, current: string, next: string): Promise<void> {
  if (!op.id) throw badRequest(m('opadmin.bootstrapNoPassword'));
  if (next.length < MIN_OPERATOR_PASSWORD) throw badRequest(m('opadmin.passwordShort', { min: MIN_OPERATOR_PASSWORD }));
  await withSystem(async (c) => {
    const acc = (await c.query<{ password_hash: string }>('SELECT password_hash FROM operator_accounts WHERE id = $1 AND active', [op.id])).rows[0];
    if (!acc || !(await verifyPassword(current, acc.password_hash))) throw badRequest(m('opadmin.passwordWrong'));
    if (await verifyPassword(next, acc.password_hash)) throw badRequest(m('opadmin.passwordSame'));
    await c.query('UPDATE operator_accounts SET password_hash = $2, must_change_password = false, updated_at = now() WHERE id = $1', [
      op.id,
      await hashPassword(next),
    ]);
    await operatorLog(c, op, 'operator.password', null, {});
  });
}
