import { describe, expect, it } from 'vitest';
import { sanitizeAvatarUrl } from './avatarUrl';

/**
 * The `picture` claim is attacker-influenceable input: whatever survives this
 * function is written to users.image and then fetched by every viewer's
 * browser. So these tests are mostly about REFUSAL.
 */
describe('sanitizeAvatarUrl', () => {
  it('accepts a real Google avatar URL', () => {
    const url = 'https://lh3.googleusercontent.com/a/ACg8ocL-abc123=s96-c';
    expect(sanitizeAvatarUrl(url)).toBe(url);
  });

  it('accepts the other lh* shards Google rotates between', () => {
    for (const host of ['lh3', 'lh4', 'lh5', 'lh6']) {
      const url = `https://${host}.googleusercontent.com/a/photo`;
      expect(sanitizeAvatarUrl(url)).toBe(url);
    }
  });

  it('refuses any host outside googleusercontent.com', () => {
    // The whole point of the allowlist: a forged token must not be able to
    // park a tracking pixel in the database.
    expect(sanitizeAvatarUrl('https://evil.example.com/pixel.gif')).toBeNull();
    expect(sanitizeAvatarUrl('https://google.com/a/photo')).toBeNull();
  });

  it('refuses a lookalike host that merely CONTAINS the allowed domain', () => {
    // endsWith on the bare domain would let these through; the leading dot in
    // ALLOWED_HOST_SUFFIX is what stops them.
    expect(sanitizeAvatarUrl('https://googleusercontent.com.evil.test/a')).toBeNull();
    expect(sanitizeAvatarUrl('https://notgoogleusercontent.com/a')).toBeNull();
  });

  it('refuses non-https schemes, including javascript: and data:', () => {
    expect(sanitizeAvatarUrl('http://lh3.googleusercontent.com/a/photo')).toBeNull();
    expect(sanitizeAvatarUrl('javascript:alert(1)')).toBeNull();
    expect(sanitizeAvatarUrl('data:image/png;base64,iVBORw0KGgo=')).toBeNull();
  });

  it('refuses embedded credentials and explicit ports', () => {
    expect(sanitizeAvatarUrl('https://user:pw@lh3.googleusercontent.com/a')).toBeNull();
    expect(sanitizeAvatarUrl('https://lh3.googleusercontent.com:8443/a')).toBeNull();
  });

  it('refuses anything that is not a non-empty string, and anything oversized', () => {
    expect(sanitizeAvatarUrl(null)).toBeNull();
    expect(sanitizeAvatarUrl(undefined)).toBeNull();
    expect(sanitizeAvatarUrl(42)).toBeNull();
    expect(sanitizeAvatarUrl({ href: 'https://lh3.googleusercontent.com/a' })).toBeNull();
    expect(sanitizeAvatarUrl('   ')).toBeNull();
    expect(sanitizeAvatarUrl(`https://lh3.googleusercontent.com/${'a'.repeat(600)}`)).toBeNull();
  });

  it('is case-insensitive about the host, as DNS is', () => {
    const url = 'https://LH3.GoogleUserContent.com/a/photo';
    expect(sanitizeAvatarUrl(url)).toBe(url);
  });
});
