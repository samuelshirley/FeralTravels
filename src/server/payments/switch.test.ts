import { describe, it, expect, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/server/db/client', () => ({ db: {} }));
vi.mock('@/server/repos/trips', () => ({ cloneTrip: vi.fn(), createTrip: vi.fn() }));
vi.mock('@/server/repos/vehicles', () => ({ addVehicle: vi.fn() }));

import { applySwitch } from './entitlements';
import { resolveAccountState } from './states';
import { paywallEnabled } from './switch';

/**
 * The master switch, which had no test at all — and that gap is exactly what
 * turned PR #17's E2E job red.
 *
 * `subscriptions.spec.ts` was written before the switch existed. It sets up an
 * account's age, spend and subscription row, then asserts the wall appears.
 * With `PAYWALL_ENABLED` unset — which is the DEFAULT, and which no workflow
 * sets — `applySwitch` forces `entitled: true` for everyone, so every spec that
 * asserts a block asserts against an app that is deliberately not blocking.
 *
 * These tests pin both halves of that, so the next person to change the default
 * finds out from the unit suite in seconds rather than from a red E2E job.
 */

const THIRTY_DAYS_AGO = new Date('2026-07-28T00:00:00Z');
const NOW = new Date('2026-08-27T00:00:00Z');

/** A real, unambiguously blocked verdict: trial long over, nothing bought. */
const blocked = () =>
  resolveAccountState({
    now: NOW,
    createdAt: THIRTY_DAYS_AGO,
    comped: false,
    anthropicMicrocents12mo: 0,
    subscription: null,
  });

describe('paywallEnabled', () => {
  it('is off unless the value is exactly "1"', () => {
    expect(paywallEnabled({})).toBe(false);
    expect(paywallEnabled({ PAYWALL_ENABLED: undefined })).toBe(false);
    expect(paywallEnabled({ PAYWALL_ENABLED: '' })).toBe(false);
    // Off for anything truthy-looking but not the literal 1. A paywall that
    // switched on for "true"/"yes"/"0" would be a footgun in both directions.
    expect(paywallEnabled({ PAYWALL_ENABLED: 'true' })).toBe(false);
    expect(paywallEnabled({ PAYWALL_ENABLED: '0' })).toBe(false);
    expect(paywallEnabled({ PAYWALL_ENABLED: '1' })).toBe(true);
  });
});

describe('applySwitch', () => {
  it('the verdict is genuinely blocked before the switch touches it', () => {
    const v = blocked();
    expect(v.state).toBe('trial_expired');
    expect(v.entitled).toBe(false);
    expect(v.blockReason).toBe('trial_over');
  });

  it('OFF: hands back full access while leaving the state truthful', () => {
    vi.stubEnv('PAYWALL_ENABLED', '');
    const v = applySwitch(blocked());
    // This is the line that made six E2E specs assert nothing.
    expect(v.entitled).toBe(true);
    expect(v.canViewExistingTrips).toBe(true);
    expect(v.blockReason).toBeNull();
    expect(v.enforced).toBe(false);
    // The STATE must survive, or the admin panel could never show who would be
    // blocked before the switch is turned on — which is the whole point of
    // having a switch rather than deleting the feature.
    expect(v.state).toBe('trial_expired');
    vi.unstubAllEnvs();
  });

  it('ON: the blocked verdict passes through untouched', () => {
    vi.stubEnv('PAYWALL_ENABLED', '1');
    const v = applySwitch(blocked());
    expect(v.entitled).toBe(false);
    expect(v.blockReason).toBe('trial_over');
    expect(v.enforced).toBe(true);
    vi.unstubAllEnvs();
  });

  it('never REMOVES access that the rules already granted', () => {
    // The switch is one-way on purpose: it can only ever be more permissive.
    vi.stubEnv('PAYWALL_ENABLED', '');
    const entitled = resolveAccountState({
      now: NOW,
      createdAt: NOW,
      comped: false,
      anthropicMicrocents12mo: 0,
      subscription: null,
    });
    expect(applySwitch(entitled).entitled).toBe(true);
    vi.unstubAllEnvs();
  });
});
