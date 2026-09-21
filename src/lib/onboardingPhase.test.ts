import { describe, expect, it } from 'vitest';
import { onboardingPhase } from './onboardingPhase';

describe('onboardingPhase', () => {
  it('is loading, not off, before the snapshot arrives', () => {
    expect(onboardingPhase({ isOnboarding: true, snapshot: null, error: null })).toBe('loading');
  });

  it('is off for a trip that is not onboarding, whatever else is set', () => {
    expect(onboardingPhase({ isOnboarding: false, snapshot: null, error: 'x' })).toBe('off');
  });

  it('is active once a live snapshot is in', () => {
    expect(onboardingPhase({ isOnboarding: true, snapshot: { state: 'trip_intent' }, error: null })).toBe('active');
  });

  it('keeps setup active when an answer fails after the snapshot loaded', () => {
    expect(onboardingPhase({ isOnboarding: true, snapshot: { state: 'trip_date' }, error: 'boom' })).toBe('active');
  });

  it('is off once setup reports done, before the trip prop catches up', () => {
    expect(onboardingPhase({ isOnboarding: true, snapshot: { state: 'done' }, error: null })).toBe('off');
  });

  it('is error when the snapshot fetch failed', () => {
    expect(onboardingPhase({ isOnboarding: true, snapshot: null, error: 'boom' })).toBe('error');
  });
});
