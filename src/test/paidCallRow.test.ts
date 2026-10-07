import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/server/db/client', () => ({ db: {} }));
// testSupport's imports reach Auth.js, which refuses the stub db at import.
vi.mock('@/server/auth/index', () => ({ auth: vi.fn() }));
vi.mock('@/server/auth', () => ({ auth: vi.fn() }));

import { isPaidCallRow } from '@/server/repos/testSupport';

/**
 * What the API contract specs count as a PAID call (`readFixturePaidUsage`):
 * a row recording a call actually made to Anthropic, Google or Jev. Pinned
 * because getting it wrong in either direction is silent: too wide and a
 * free refusal reads as spend (CI run 37551796542 — the replan route's error
 * log for a malformed payload); too narrow and real spend reads as free.
 */
const row = (provider: string, model: string | null, costMicrocents: number | null) => ({
  provider,
  model,
  costMicrocents,
});

describe('isPaidCallRow', () => {
  it("is NOT a call: replan's error-log row for a refused payload (no model, no cost, failed)", () => {
    expect(isPaidCallRow(row('anthropic:replan', null, null))).toBe(false);
  });

  it('is NOT a call: the truncation annotation, or a gate decision (even one carrying a tier)', () => {
    expect(isPaidCallRow(row('anthropic:replan-truncated', null, null))).toBe(false);
    expect(isPaidCallRow(row('penny:gate', 'T3', null))).toBe(false);
  });

  it('is NOT a call: the fixtures’ synthetic spend and request rows', () => {
    expect(isPaidCallRow(row('anthropic:e2e-subscription-fixture', null, 60_000_000))).toBe(false);
    expect(isPaidCallRow(row('anthropic:e2e-request-fixture', null, 0))).toBe(false);
  });

  it('IS a call: a real Anthropic call, succeeded or failed', () => {
    expect(isPaidCallRow(row('anthropic', 'claude-haiku-4-5-20251001', 8_500_000))).toBe(true);
    expect(isPaidCallRow(row('anthropic', 'claude-haiku-4-5-20251001', 0))).toBe(true);
  });

  it('IS a call: a real call whose own accounting row failed to write', () => {
    expect(isPaidCallRow(row('anthropic:accounting-write-failed', null, null))).toBe(true);
  });

  it('IS a call: Google Places (SKU in model) and Directions / Geocoding (cost, no model)', () => {
    expect(isPaidCallRow(row('google-places', 'text-search', 3_200_000))).toBe(true);
    expect(isPaidCallRow(row('google-directions', null, 500_000))).toBe(true);
    expect(isPaidCallRow(row('google-geocode', null, 500_000))).toBe(true);
  });

  it('IS a call: Jev, even at cost 0 with no model', () => {
    expect(isPaidCallRow(row('jev', null, 0))).toBe(true);
  });

  it('is NOT a call: an unrelated ledger row', () => {
    expect(isPaidCallRow(row('admin:paywall-switch', null, null))).toBe(false);
  });
});
