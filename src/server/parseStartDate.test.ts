/**
 * Tests for the pure validation helper guarding the LLM date fallback. The
 * network call itself isn't unit-tested (non-deterministic + needs a key); the
 * guard that keeps a hallucinated or malformed model response out of the DB is.
 */
import { describe, it, expect, vi } from 'vitest';

// `server-only` throws under the jsdom test env; stub it (hoisted above imports).
vi.mock('server-only', () => ({}));

import { validateISODateString } from './parseStartDate';

describe('validateISODateString', () => {
  const now = new Date(2026, 4, 31); // Sun May 31 2026

  it('accepts a well-formed future ISO date', () => {
    expect(validateISODateString('2026-06-03', now)).toBe('2026-06-03');
    expect(validateISODateString('  2027-01-05  ', now)).toBe('2027-01-05');
  });

  it('rejects malformed or non-string input', () => {
    expect(validateISODateString('June 3 2026', now)).toBeNull();
    expect(validateISODateString('2026-6-3', now)).toBeNull(); // not zero-padded
    expect(validateISODateString('2026/06/03', now)).toBeNull();
    expect(validateISODateString(null, now)).toBeNull();
    expect(validateISODateString(undefined, now)).toBeNull();
    expect(validateISODateString(20260603, now)).toBeNull();
    expect(validateISODateString({ date: '2026-06-03' }, now)).toBeNull();
  });

  it('rejects impossible calendar days', () => {
    expect(validateISODateString('2026-02-30', now)).toBeNull();
    expect(validateISODateString('2026-13-01', now)).toBeNull();
    expect(validateISODateString('2026-00-10', now)).toBeNull();
  });

  it('rejects dates outside the sane trip window', () => {
    expect(validateISODateString('1999-06-03', now)).toBeNull();
    expect(validateISODateString('2024-06-03', now)).toBeNull(); // >1yr in the past
    expect(validateISODateString('2200-06-03', now)).toBeNull();
  });

  it('allows up to one year in the past for clock skew / edits', () => {
    expect(validateISODateString('2025-12-31', now)).toBe('2025-12-31');
  });
});
