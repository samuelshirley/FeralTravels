import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  decryptEmail,
  encryptEmail,
  hashEmail,
  isEmailEncryptionConfigured,
} from './deletedUserCrypto';

const KEY = 'DELETED_USER_ENC_KEY';
const original = process.env[KEY];

function setKey(v: string | undefined) {
  if (v === undefined) delete process.env[KEY];
  else process.env[KEY] = v;
}

beforeEach(() => setKey(undefined));
afterEach(() => setKey(original));

describe('hashEmail', () => {
  it('is deterministic and normalizes case + whitespace', () => {
    // Without normalization the same human address typed two ways would hash
    // differently and "did this person ever have an account?" would answer no.
    const a = hashEmail('Sam@Example.com');
    expect(hashEmail('  sam@example.com ')).toBe(a);
    expect(hashEmail('sam@example.com')).toBe(a);
  });

  it('produces a hex sha-256 and differs per address', () => {
    expect(hashEmail('a@b.com')).toMatch(/^[0-9a-f]{64}$/);
    expect(hashEmail('a@b.com')).not.toBe(hashEmail('c@d.com'));
  });

  it('works with no key configured', () => {
    // This is the guarantee that makes the hash the primary record: churn
    // counting and "was this deleted?" survive a missing key entirely.
    expect(isEmailEncryptionConfigured()).toBe(false);
    expect(hashEmail('a@b.com')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is keyed — the digest changes once a key is configured', () => {
    // The whole reason this is an HMAC. An email address is enumerable, so a
    // bare SHA-256 column can be attacked offline by anyone holding a dump; a
    // keyed digest cannot, because the key is not in the database. If this test
    // fails, the column has silently become guessable.
    const unkeyed = hashEmail('sam@example.com');
    setKey(randomBytes(32).toString('base64'));
    const keyed = hashEmail('sam@example.com');
    expect(keyed).not.toBe(unkeyed);
    expect(keyed).toMatch(/^[0-9a-f]{64}$/);
    // Still deterministic under a given key — lookups depend on it.
    expect(hashEmail('SAM@example.com ')).toBe(keyed);
  });

  it('changes with the key, which is why rotation breaks old lookups', () => {
    setKey(randomBytes(32).toString('base64'));
    const a = hashEmail('sam@example.com');
    setKey(randomBytes(32).toString('base64'));
    expect(hashEmail('sam@example.com')).not.toBe(a);
  });
});

describe('encryptEmail / decryptEmail', () => {
  it('returns null instead of throwing when no key is configured', () => {
    // A deletion must never fail because bookkeeping is misconfigured.
    expect(encryptEmail('sam@example.com')).toBeNull();
    expect(decryptEmail('v1:a:b:c')).toBeNull();
  });

  it('round-trips with a base64 key', () => {
    setKey(randomBytes(32).toString('base64'));
    expect(isEmailEncryptionConfigured()).toBe(true);
    const enc = encryptEmail('sam@example.com');
    expect(enc).toMatch(/^v1:/);
    expect(enc).not.toContain('sam@example.com');
    expect(decryptEmail(enc)).toBe('sam@example.com');
  });

  it('round-trips with a hex key', () => {
    setKey(randomBytes(32).toString('hex'));
    const enc = encryptEmail('sam@example.com');
    expect(decryptEmail(enc)).toBe('sam@example.com');
  });

  it('rejects a key that is not 32 bytes rather than padding it', () => {
    // A silently-padded short key would look like it worked while providing a
    // fraction of the strength it claims.
    setKey(Buffer.from('too short').toString('base64'));
    expect(isEmailEncryptionConfigured()).toBe(false);
    expect(encryptEmail('sam@example.com')).toBeNull();
  });

  it('produces different ciphertext for the same address each time', () => {
    // Per-value IV: two accounts on the same address must not be linkable by
    // eyeballing the column. The hash column is the deterministic one.
    setKey(randomBytes(32).toString('base64'));
    expect(encryptEmail('sam@example.com')).not.toBe(encryptEmail('sam@example.com'));
  });

  it('returns null for a row encrypted under a different key', () => {
    setKey(randomBytes(32).toString('base64'));
    const enc = encryptEmail('sam@example.com');
    setKey(randomBytes(32).toString('base64'));
    expect(decryptEmail(enc)).toBeNull();
  });

  it('returns null for tampered ciphertext instead of plausible garbage', () => {
    // GCM's auth tag is the reason this is detectable at all.
    setKey(randomBytes(32).toString('base64'));
    const enc = encryptEmail('sam@example.com')!;
    const parts = enc.split(':');
    const flipped = Buffer.from(parts[3], 'base64');
    flipped[0] ^= 0xff;
    parts[3] = flipped.toString('base64');
    expect(decryptEmail(parts.join(':'))).toBeNull();
  });

  it('returns null for malformed, empty or unknown-version payloads', () => {
    setKey(randomBytes(32).toString('base64'));
    expect(decryptEmail(null)).toBeNull();
    expect(decryptEmail('')).toBeNull();
    expect(decryptEmail('not-a-payload')).toBeNull();
    expect(decryptEmail('v2:a:b:c')).toBeNull();
    expect(decryptEmail('v1:a:b')).toBeNull();
  });
});
