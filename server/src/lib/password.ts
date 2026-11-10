import { createHash } from 'node:crypto';
import { config } from '../config.js';
import { m, type MessageKey } from '../i18n/index.js';
import { COMMON_BASE, COMMON_LONG } from './common-passwords.js';
import { HttpError } from './errors.js';

// Password policy (enterprise hardening): minimum length per tenant (setting
// security.passwordMinLength, at least 10), no very common passwords and, optionally, no
// passwords known from data breaches (PASSWORD_BREACH_CHECK=hibp, k-anonymity: only the first
// five characters of the SHA-1 hash leave the server).

export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 200;

const LONG = new Set(COMMON_LONG.split('\n'));
const BASE = new Set(COMMON_BASE.split('\n'));

export type PasswordProblem = 'tooShort' | 'tooLong' | 'common' | 'personal' | 'breached';

/** True for passwords from the embedded lists, simple repetitions and sequences. */
export function isCommonPassword(password: string): boolean {
  const lower = password.toLowerCase();
  if (LONG.has(lower)) return true;
  // A frequent word with only digits or symbols around it ("Passwort2024!", "!!sunshine123").
  const core = lower.replace(/^[^a-z]+|[^a-z]+$/g, '');
  if (core && BASE.has(core) && core.length >= lower.length - 8) return true;
  // One character repeated, or a short pattern repeated ("abcabcabcabc", "1212121212").
  if (/^(.{1,4})\1+$/.test(lower)) return true;
  // Ascending or descending runs of digits or letters.
  const codes = [...lower].map((c) => c.charCodeAt(0));
  const steps = codes.slice(1).map((c, i) => c - codes[i]);
  if (steps.length && (steps.every((d) => d === 1) || steps.every((d) => d === -1))) return true;
  return false;
}

/** Checks a new password; returns the first problem or null. Without network. */
export function passwordProblem(password: string, opts: { minLength?: number; email?: string | null; workspace?: string | null } = {}): PasswordProblem | null {
  const min = Math.max(PASSWORD_MIN, opts.minLength ?? PASSWORD_MIN);
  if ([...password].length < min) return 'tooShort';
  if (password.length > PASSWORD_MAX) return 'tooLong';
  if (isCommonPassword(password)) return 'common';
  const lower = password.toLowerCase();
  const local = opts.email?.split('@')[0]?.toLowerCase();
  if (local && local.length >= 4 && lower.includes(local)) return 'personal';
  const ws = opts.workspace?.toLowerCase().replace(/[^a-z0-9äöüß]/g, '');
  if (ws && ws.length >= 4 && lower.replace(/[^a-z0-9äöüß]/g, '') === ws) return 'personal';
  return null;
}

// ---------------------------------------------------------------- breach check (optional)

export type BreachLookup = (prefix: string) => Promise<string>;

const hibpLookup: BreachLookup = async (prefix) => {
  const res = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
    headers: { 'add-padding': 'true', 'user-agent': 'Ideenportal-Password-Check' },
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) throw new Error(`hibp ${res.status}`);
  return res.text();
};

let breachLookup: BreachLookup = hibpLookup;

/** Tests replace the lookup; without argument the real service is restored. */
export function setBreachLookup(fn?: BreachLookup): void {
  breachLookup = fn ?? hibpLookup;
}

/**
 * True when the password appears in the Have I Been Pwned range answer. Only with
 * PASSWORD_BREACH_CHECK=hibp; a failing service never blocks the password (fail open, logged).
 */
export async function isBreachedPassword(password: string): Promise<boolean> {
  if (config.passwordBreachCheck !== 'hibp') return false;
  const sha1 = createHash('sha1').update(password).digest('hex').toUpperCase();
  const prefix = sha1.slice(0, 5);
  const suffix = sha1.slice(5);
  try {
    const body = await breachLookup(prefix);
    return body.split('\n').some((line) => {
      const [hash, count] = line.trim().split(':');
      return hash === suffix && Number(count) > 0;
    });
  } catch (err) {
    console.warn(`[password] breach check unavailable: ${(err as Error).message.slice(0, 80)}`);
    return false;
  }
}

/** Throws 400 with a localized message when the password does not meet the policy. */
export async function assertPasswordPolicy(
  password: string,
  opts: { minLength?: number; email?: string | null; workspace?: string | null } = {},
): Promise<void> {
  const problem = passwordProblem(password, opts) ?? ((await isBreachedPassword(password)) ? 'breached' : null);
  if (!problem) return;
  const min = Math.max(PASSWORD_MIN, opts.minLength ?? PASSWORD_MIN);
  throw new HttpError(400, m(`security.password.${problem}` as MessageKey, { min, max: PASSWORD_MAX }), 'PASSWORD_POLICY', { reason: problem });
}
