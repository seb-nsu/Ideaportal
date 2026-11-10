import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, hashPassword, totp, verifyPassword, verifyTotp } from '../src/lib/crypto.js';

describe('crypto', () => {
  it('hashes and verifies passwords', async () => {
    const h = await hashPassword('geheim-123456');
    expect(await verifyPassword('geheim-123456', h)).toBe(true);
    expect(await verifyPassword('falsch', h)).toBe(false);
    expect(await verifyPassword('x', null)).toBe(false);
  });

  it('matches the RFC 6238 test vector (SHA-1)', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    expect(base32Decode(secret).toString()).toBe('12345678901234567890');
    // RFC 6238 Appendix B: T = 59 s -> 94287082 (8 digits) -> last 6 digits 287082
    expect(totp(secret, 59_000)).toBe('287082');
    expect(verifyTotp(secret, '287082', 59_000)).toBe(true);
    expect(verifyTotp(secret, '000000', 59_000)).toBe(false);
  });
});
