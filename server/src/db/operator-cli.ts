import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { base32Encode } from '../lib/crypto.js';
import { closePool, withSystem } from './pool.js';
import { migrate } from './migrate.js';
import { OPERATOR_ROLES, operatorLog, type OperatorRole } from '../services/operator.js';
import { createOperator, listOperators, resetOperator } from '../services/operatorAccounts.js';

// Operator console (R3-07, enterprise): command line for operator accounts.
//
//   npm run operator -w server -- create --email ops@example.com --name "Vera Betrieb" --role owner
//   npm run operator -w server -- list
//   npm run operator -w server -- reset --email ops@example.com
//   npm run operator -w server -- deactivate --email ops@example.com
//   npm run operator -w server -- setup      (values for the bootstrap login with OPERATOR_TOKEN)
//
// "create" prints a start password and the TOTP secret once; the password must be changed at
// the first login. The actions are written to the operator log as "cli".

const USAGE = `usage: npm run operator -w server -- <command>
  create --email <address> --name <name> [--role owner|support|billing|technical]
  list
  reset --email <address>
  deactivate --email <address>
  setup`;

function printCredentials(c: { password: string; totpSecret: string; otpauthUrl: string }) {
  console.log(`start password (change at first login): ${c.password}`);
  console.log(`TOTP secret: ${c.totpSecret}`);
  console.log('Add the TOTP secret to an authenticator app (manually or from this URL):');
  console.log(c.otpauthUrl);
}

async function main(): Promise<number> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { email: { type: 'string' }, name: { type: 'string' }, role: { type: 'string' } },
  });
  const [cmd] = positionals;
  if (cmd === 'setup') {
    const token = randomBytes(32).toString('base64url');
    const totp = base32Encode(randomBytes(20));
    const label = encodeURIComponent('Ideenportal Betrieb');
    console.log(`OPERATOR_TOKEN=${token}`);
    console.log(`OPERATOR_TOTP_SECRET=${totp}`);
    console.log('');
    console.log('Bootstrap only: works while no active owner account exists (or with OPERATOR_BREAK_GLASS=true).');
    console.log('Add the TOTP secret to an authenticator app (manually or from this URL):');
    console.log(`otpauth://totp/${label}?secret=${totp}&issuer=${label}`);
    return 0;
  }
  if (!['create', 'list', 'reset', 'deactivate'].includes(cmd ?? '')) {
    console.log(USAGE);
    return cmd ? 1 : 0;
  }
  await migrate(() => undefined);
  if (cmd === 'list') {
    for (const o of await listOperators()) {
      console.log(`${o.active ? 'active  ' : 'inactive'}  ${o.role.padEnd(9)}  ${o.email}  ${o.name}${o.lastLoginAt ? `  last login ${new Date(o.lastLoginAt).toISOString()}` : ''}`);
    }
    return 0;
  }
  if (!values.email) {
    console.log(USAGE);
    return 1;
  }
  if (cmd === 'create') {
    const role = (values.role ?? 'owner') as OperatorRole;
    if (!OPERATOR_ROLES.includes(role) || !values.name) {
      console.log(USAGE);
      return 1;
    }
    const c = await createOperator('cli', { email: values.email, name: values.name, role });
    console.log(`operator account created: ${values.email} (${role})`);
    printCredentials(c);
    return 0;
  }
  const id = await withSystem(async (c) => (await c.query<{ id: string }>('SELECT id FROM operator_accounts WHERE lower(email) = lower($1)', [values.email])).rows[0]?.id);
  if (!id) {
    console.error('no operator account with this e-mail address');
    return 1;
  }
  if (cmd === 'reset') {
    printCredentials(await resetOperator('cli', id));
    return 0;
  }
  await withSystem(async (c) => {
    await c.query('UPDATE operator_accounts SET active = false, updated_at = now() WHERE id = $1', [id]);
    await c.query('DELETE FROM operator_sessions WHERE operator_id = $1', [id]);
    await operatorLog(c, 'cli', 'operator.update', null, { id, after: { active: false } });
  });
  console.log('operator account deactivated');
  return 0;
}

main()
  .then(async (code) => {
    await closePool();
    process.exit(code);
  })
  .catch(async (err) => {
    console.error(err instanceof Error ? err.message : err);
    await closePool();
    process.exit(1);
  });
