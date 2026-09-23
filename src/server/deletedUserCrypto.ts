import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';

/**
 * Crypto for the `deleted_users` tombstone — and, through `encryptSecret`, for
 * the Sign in with Apple refresh tokens held in `accounts` so account deletion
 * can revoke them. Two different jobs, deliberately
 * kept apart because they answer different questions and carry different risk.
 *
 * `hashEmail` is a one-way keyed digest. It answers "did this address ever have
 * an account?" — you hash a candidate and look for a match — and cannot be run
 * backwards into an address.
 *
 * It is an HMAC, not a bare SHA-256, and that distinction is the point. Email
 * addresses are low-entropy and enumerable: anyone holding a dump of a plain-SHA
 * column can hash a breach corpus or a list of `first.last@gmail.com`
 * permutations offline and confirm membership. That matters more here than in
 * most apps, because CI puts a clone of the production database behind a public
 * preview URL. Keying the digest with a secret the database does not contain
 * makes that attack need the key too.
 *
 * `encryptEmail` is real, reversible AES-256-GCM. It answers "who deleted their
 * account?" and therefore still holds personal data — just not data the database
 * can give up on its own, because the key lives in the environment. Only the
 * admin surface decrypts.
 *
 * GCM (not CBC) so the ciphertext is authenticated: a tampered row fails to
 * decrypt loudly instead of returning plausible garbage. A fresh 12-byte IV per
 * value means two accounts with the same address do not produce the same
 * ciphertext — the hash column is the one that is deliberately deterministic.
 */

const KEY_ENV = 'DELETED_USER_ENC_KEY';
const VERSION = 'v1';
const IV_BYTES = 12;

/**
 * Resolve the key, or null if it is absent/unusable.
 *
 * Returning null rather than throwing is the whole contract of this module: a
 * user's deletion request must never fail because our churn bookkeeping is
 * misconfigured. A missing key costs us the readable address and nothing else.
 *
 * Accepts base64 or hex, and requires exactly 32 bytes — a short key silently
 * padded would be worse than no key at all.
 */
function getKey(): Buffer | null {
  const raw = process.env[KEY_ENV]?.trim();
  if (!raw) return null;
  let key: Buffer;
  try {
    key = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  } catch {
    return null;
  }
  return key.length === 32 ? key : null;
}

/** True when a usable key is configured — lets callers explain a null cleanly. */
export function isEmailEncryptionConfigured(): boolean {
  return getKey() !== null;
}

/**
 * Deterministic keyed digest of the normalized address.
 *
 * Normalization (trim + lowercase) matters: without it the same human address
 * typed two ways would hash differently and a later lookup would miss.
 *
 * Keyed with `DELETED_USER_ENC_KEY` when one is configured, so a single env
 * secret protects both columns and there is only one thing to rotate.
 * **Rotating the key changes every future digest**, so `wasEmailDeleted` stops
 * matching rows written under the old one — the same trade-off the encrypted
 * column already carries, and the reason to set the key once and leave it.
 *
 * With no key it falls back to a bare SHA-256, so deletion still works in a
 * checkout with no secrets. Such a row is pseudonymous rather than anonymous —
 * guessable by anyone holding the table. Set the key.
 */
export function hashEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  const key = getKey();
  return key
    ? createHmac('sha256', key).update(normalized).digest('hex')
    : createHash('sha256').update(normalized).digest('hex');
}

/**
 * Encrypt an arbitrary secret under the same key and format as the tombstone.
 * Null when no key is configured — the caller decides what "no key" means for
 * its data; it must never fall back to storing the plaintext.
 *
 * Format is `v1:<iv>:<authTag>:<ciphertext>`, all base64. The version prefix is
 * there so a future key rotation or algorithm change can be detected per-row
 * instead of guessing. Unlike `encryptEmail`, the value is stored byte for byte:
 * a Sign in with Apple refresh token is case-sensitive.
 */
export function encryptSecret(plaintext: string): string | null {
  const key = getKey();
  if (!key) return null;
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [
    VERSION,
    iv.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    enc.toString('base64'),
  ].join(':');
}

/**
 * Reverse of `encryptSecret`. Returns null on every failure mode — no key,
 * wrong key, wrong version, malformed row, failed auth tag — so one bad row is
 * something the caller reports rather than an exception that takes the rest
 * down with it.
 */
export function decryptSecret(payload: string | null | undefined): string | null {
  if (!payload) return null;
  const key = getKey();
  if (!key) return null;
  const parts = payload.split(':');
  if (parts.length !== 4 || parts[0] !== VERSION) return null;
  try {
    const iv = Buffer.from(parts[1], 'base64');
    const tag = Buffer.from(parts[2], 'base64');
    const data = Buffer.from(parts[3], 'base64');
    if (iv.length !== IV_BYTES) return null;
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/**
 * Encrypt an address for later admin reading. Null when no key is configured,
 * which the caller stores as-is. The address is normalized first (trim +
 * lowercase); the format is `encryptSecret`'s.
 */
export function encryptEmail(email: string): string | null {
  return encryptSecret(email.trim().toLowerCase());
}

/**
 * Reverse of `encryptEmail`. Null on every failure mode, because the only
 * caller is an admin list that should render "unavailable" for one bad row
 * rather than throwing and taking the whole page down.
 */
export function decryptEmail(payload: string | null | undefined): string | null {
  return decryptSecret(payload);
}
