import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { anthropicApiKey, hasAnthropicApiKey } from './anthropicKey';

/**
 * The production exclusion is the only thing here worth testing, and it is
 * worth testing because its failure is invisible: production would bill the CI
 * key, nothing would error, and the separation this exists to create would be
 * silently undone. `ANTHROPIC_API_KEY_CI` reaching the production environment
 * is not a hypothetical — "All Environments" is Vercel's default when adding a
 * variable.
 */
const KEYS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY_CI', 'VERCEL_ENV'] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
});

describe('anthropicApiKey', () => {
  it('uses the CI key when one is set and this is not production', () => {
    process.env.ANTHROPIC_API_KEY = 'prod-key';
    process.env.ANTHROPIC_API_KEY_CI = 'ci-key';
    process.env.VERCEL_ENV = 'preview';
    expect(anthropicApiKey()).toBe('ci-key');
  });

  it('a laptop with no VERCEL_ENV is not production, and uses the CI key', () => {
    // A quarter of the unattributed spend in the 2026-09-01..08 window was a
    // `next dev` server on a developer's machine, so this case is the point.
    process.env.ANTHROPIC_API_KEY = 'prod-key';
    process.env.ANTHROPIC_API_KEY_CI = 'ci-key';
    expect(anthropicApiKey()).toBe('ci-key');
  });

  it('REFUSES the CI key on production, even when it is set there', () => {
    process.env.ANTHROPIC_API_KEY = 'prod-key';
    process.env.ANTHROPIC_API_KEY_CI = 'ci-key';
    process.env.VERCEL_ENV = 'production';
    expect(anthropicApiKey()).toBe('prod-key');
  });

  it('falls back to the normal key when no CI key is configured', () => {
    process.env.ANTHROPIC_API_KEY = 'prod-key';
    process.env.VERCEL_ENV = 'preview';
    expect(anthropicApiKey()).toBe('prod-key');
  });

  it('treats a blank or whitespace CI key as absent, not as a key', () => {
    // Vercel and GitHub both happily store an empty string, and an empty
    // apiKey would fail every call with a 401 rather than falling back.
    process.env.ANTHROPIC_API_KEY = 'prod-key';
    process.env.ANTHROPIC_API_KEY_CI = '   ';
    expect(anthropicApiKey()).toBe('prod-key');
  });

  it('is undefined, never an empty string, when nothing is configured', () => {
    // Every caller branches on falsiness to skip the LLM call; `''` would pass
    // a `!= null` check and construct a client that cannot work.
    expect(anthropicApiKey()).toBeUndefined();
    process.env.ANTHROPIC_API_KEY = '';
    expect(anthropicApiKey()).toBeUndefined();
    expect(hasAnthropicApiKey()).toBe(false);
  });

  it('reports a key as present when only the CI key is set', () => {
    // The preview environment is configured exactly this way, and the old
    // `if (!process.env.ANTHROPIC_API_KEY) return null` would have reported no
    // key at all there — every onboarding scan silently skipped.
    process.env.ANTHROPIC_API_KEY_CI = 'ci-key';
    expect(hasAnthropicApiKey()).toBe(true);
    expect(anthropicApiKey()).toBe('ci-key');
  });

  it('reads the environment at call time, so a later change is honoured', () => {
    process.env.ANTHROPIC_API_KEY = 'first';
    expect(anthropicApiKey()).toBe('first');
    process.env.ANTHROPIC_API_KEY = 'second';
    expect(anthropicApiKey()).toBe('second');
  });
});
