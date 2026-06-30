import { describe, it, expect } from 'vitest';
import {
  isRateLimitSignal,
  shouldSendAlert,
  RATE_LIMIT_ALERT_COOLDOWN_MS,
} from './dataSourceRateLimit';

describe('isRateLimitSignal', () => {
  it('matches Overpass 429 failure text', () => {
    expect(
      isRateLimitSignal(
        "Couldn't reach the OSM station service (Overpass request failed: HTTP 429). Try again shortly."
      )
    ).toBe(true);
  });

  it('matches OSRM overload codes', () => {
    expect(isRateLimitSignal('OSRM HTTP 504')).toBe(true);
    expect(isRateLimitSignal('OSRM HTTP 503')).toBe(true);
  });

  it('matches common wording', () => {
    expect(isRateLimitSignal('Too Many Requests')).toBe(true);
    expect(isRateLimitSignal('you have been rate limited')).toBe(true);
  });

  it('does NOT match unrelated failures', () => {
    expect(isRateLimitSignal('Route geometry was unusable')).toBe(false);
    expect(isRateLimitSignal('No vehicle on file for user')).toBe(false);
    expect(isRateLimitSignal(null)).toBe(false);
    expect(isRateLimitSignal('')).toBe(false);
  });

  it('does not false-match a 4290 km distance or similar embedded digits', () => {
    // word-boundary anchored: 429 inside 4290 should not match
    expect(isRateLimitSignal('planned a 4290 km leg')).toBe(false);
  });
});

describe('shouldSendAlert', () => {
  const now = 1_000_000_000_000;
  it('sends when never sent before', () => {
    expect(shouldSendAlert(null, now)).toBe(true);
  });
  it('suppresses within the cooldown window', () => {
    expect(shouldSendAlert(now - 1000, now)).toBe(false);
    expect(shouldSendAlert(now - (RATE_LIMIT_ALERT_COOLDOWN_MS - 1), now)).toBe(false);
  });
  it('sends again once the cooldown has elapsed', () => {
    expect(shouldSendAlert(now - RATE_LIMIT_ALERT_COOLDOWN_MS, now)).toBe(true);
    expect(shouldSendAlert(now - 2 * RATE_LIMIT_ALERT_COOLDOWN_MS, now)).toBe(true);
  });
});
