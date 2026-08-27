import { describe, it, expect } from 'vitest';
import {
  decidePromoRedemption,
  formatPromoCode,
  generatePromoCode,
  isPromoCodeShape,
  normalizePromoCode,
  PROMO_PREFIX,
  type PromoCodeFacts,
} from './promoCode';

const AT = (iso: string) => new Date(iso);

describe('normalizePromoCode', () => {
  it('is indifferent to the things a person does when typing off a phone', () => {
    // Every one of these is the SAME code. The recipient is copying it out of a
    // message; the database should not hold an opinion about their typing.
    for (const typed of [
      'FERAL-4KQP-8XZM',
      'feral-4kqp-8xzm',
      ' FERAL 4KQP 8XZM ',
      'feral4kqp8xzm',
      'FERAL–4KQP–8XZM', // en dashes, courtesy of an autocorrecting keyboard
    ]) {
      expect(normalizePromoCode(typed)).toBe('FERAL4KQP8XZM');
    }
  });
});

describe('code shape', () => {
  it('accepts the canonical form in any of its typed spellings', () => {
    expect(isPromoCodeShape('FERAL-4KQP-8XZM')).toBe(true);
    expect(isPromoCodeShape('feral4kqp8xzm')).toBe(true);
  });

  it('rejects near misses rather than trying to be clever about them', () => {
    expect(isPromoCodeShape('FERAL-4KQP-8XZ')).toBe(false); // one short
    expect(isPromoCodeShape('FERAL-4KQP-8XZMM')).toBe(false); // one long
    expect(isPromoCodeShape('OTHER-4KQP-8XZM')).toBe(false); // wrong prefix
    expect(isPromoCodeShape('')).toBe(false);
  });

  it('rejects the ambiguous characters the alphabet deliberately omits', () => {
    // O/0, I/1/L, S/5 and U are not in the alphabet, so a code containing one
    // was mistyped — and saying so is better than a lookup miss that reads as
    // "your code is invalid" when the code was fine.
    for (const ch of ['O', 'I', 'L', 'S', 'U', '0', '1', '5']) {
      expect(isPromoCodeShape(`${PROMO_PREFIX}${ch}KQP8XZM`), ch).toBe(false);
    }
  });
});

describe('formatPromoCode', () => {
  it('round-trips through normalize', () => {
    const canonical = 'FERAL4KQP8XZM';
    expect(formatPromoCode(canonical)).toBe('FERAL-4KQP-8XZM');
    expect(normalizePromoCode(formatPromoCode(canonical))).toBe(canonical);
  });
});

describe('generatePromoCode', () => {
  it('produces a code that satisfies its own validator', () => {
    let n = 0;
    const bytes = (len: number) => Uint8Array.from({ length: len }, () => (n++ * 7) % 256);
    expect(isPromoCodeShape(generatePromoCode(bytes))).toBe(true);
  });

  it('rejection-samples rather than taking a modulo', () => {
    /**
     * The alphabet has 27 characters and 256 is not a multiple of 27, so
     * `byte % 27` would make the first four letters measurably likelier than
     * the rest. This is the assertion that catches someone "simplifying" it
     * back: byte 255 is above the rejection limit (243) and must be DISCARDED,
     * not folded round to index 3.
     *
     * Feeding 255s forever would hang, so the source yields 255 first and then
     * zeroes — a correct implementation ignores the 255 and returns a code of
     * all-first-character.
     */
    let first = true;
    const bytes = (len: number) => {
      const out = new Uint8Array(len);
      if (first) {
        out.fill(255);
        first = false;
      }
      return out;
    };
    const code = generatePromoCode(bytes);
    expect(code).toBe(`${PROMO_PREFIX}AAAAAAAA`);
  });
});

describe('decidePromoRedemption', () => {
  const base: PromoCodeFacts = {
    code: 'FERAL4KQP8XZM',
    email: 'alice@example.com',
    expiresAt: null,
    redeemedAt: null,
  };
  const now = AT('2026-08-27T12:00:00Z');

  it('lets the bound account through', () => {
    expect(decidePromoRedemption(base, { email: 'alice@example.com', now })).toEqual({ ok: true });
  });

  it('compares the address case-insensitively and ignores stray whitespace', () => {
    // users.email is NOT guaranteed lowercase — the NextAuth adapter inserts
    // the provider's profile.email verbatim. The account-deletion code carries
    // the same warning for the same reason.
    expect(decidePromoRedemption(base, { email: '  Alice@Example.COM ', now })).toEqual({
      ok: true,
    });
  });

  it('refuses an unknown code', () => {
    expect(decidePromoRedemption(null, { email: 'alice@example.com', now })).toEqual({
      ok: false,
      reason: 'promo_not_found',
    });
  });

  it('refuses a code that has already been spent', () => {
    expect(
      decidePromoRedemption(
        { ...base, redeemedAt: AT('2026-08-01T00:00:00Z') },
        { email: 'alice@example.com', now }
      )
    ).toEqual({ ok: false, reason: 'promo_already_redeemed' });
  });

  it('refuses a code past its redemption deadline, and allows one on the last moment before', () => {
    const expiresAt = AT('2026-08-27T12:00:00Z');
    expect(decidePromoRedemption({ ...base, expiresAt }, { email: 'alice@example.com', now })).toEqual(
      { ok: false, reason: 'promo_expired' }
    );
    expect(
      decidePromoRedemption(
        { ...base, expiresAt },
        { email: 'alice@example.com', now: AT('2026-08-27T11:59:59Z') }
      )
    ).toEqual({ ok: true });
  });

  it('tells a stranger nothing except that the code is not theirs', () => {
    /**
     * The ordering assertion, and the reason the checks are in the order they
     * are. Somebody holding a forwarded code must not be able to learn whether
     * it has been used, or when it lapsed, by trying it — both are facts about
     * the real recipient's account. Every one of these is the same refusal.
     */
    const stranger = { email: 'mallory@example.com', now };
    expect(decidePromoRedemption(base, stranger).ok).toBe(false);
    for (const variant of [
      { ...base, redeemedAt: AT('2026-08-01T00:00:00Z') },
      { ...base, expiresAt: AT('2026-01-01T00:00:00Z') },
      { ...base, redeemedAt: AT('2026-08-01T00:00:00Z'), expiresAt: AT('2026-01-01T00:00:00Z') },
    ]) {
      expect(decidePromoRedemption(variant, stranger)).toEqual({
        ok: false,
        reason: 'promo_wrong_account',
      });
    }
  });
});
