/**
 * The first-run chat never paints the START HERE empty state.
 *
 * The empty state was gated on `!onboardingUiActive`, and that boolean was
 * false both when setup was off AND while its snapshot was still being
 * fetched after mount. So every first-run trip painted START HERE, then threw
 * it away for the onboarding card — live in TestFlight build 8. This file
 * existed through all of it as an `it.fails` repro, which reports green while
 * the bug is present; that is why CI never objected. Never `it.fails` a guard.
 *
 * It also pins what fills the window instead: Penny's typing dots from the
 * first render, the greeting as a headline the moment the snapshot lands (not
 * three more seconds of dots), and a visible, retryable state when the
 * snapshot fails. `onboardingPhaseGuard.test.ts` holds the native panel, which
 * has no test runner, to the same gate at source level.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

const GREETING = "Where are we going? One city is enough to start — I'll sort the fuel.";

const snapshotFetch = vi.hoisted(() => ({ fail: false, calls: 0 }));

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(async (path: string) => {
    if (path.includes('/onboarding')) {
      snapshotFetch.calls += 1;
      // Resolve on a later macrotask, like a real network round trip.
      await new Promise((r) => setTimeout(r, 50));
      if (snapshotFetch.fail) throw new Error('Service unavailable');
      return {
        state: 'trip_intent',
        question: {
          key: 'trip_intent',
          kind: 'text',
          label: GREETING,
          prompts: ['Paris to Stuttgart, 5 h days', 'Pyrenees loop with 3 rest days'],
        },
        vehicles: [],
        progress: { current: 1, total: 5 },
      };
    }
    return {};
  }),
}));

vi.mock('@/components/UnitsContext', () => ({ useUnits: () => ({ units: 'metric' }) }));
vi.mock('@/components/DeviceLocationContext', () => ({ useDeviceLocation: () => ({ place: null }) }));

import ChatPanel from '@/components/ChatPanel';

const renderFirstRun = () =>
  render(
    <ChatPanel tripId="t1" initialMessages={[]} onboardingState="trip_intent" onTripUpdated={() => {}} />
  );

describe('first-run onboarding', () => {
  beforeEach(() => {
    snapshotFetch.fail = false;
    snapshotFetch.calls = 0;
    global.fetch = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })) as never;
    // jsdom has no scrollTo; the panel scrolls when the greeting lands.
    Element.prototype.scrollTo = vi.fn() as never;
  });
  afterEach(cleanup);

  it('shows Penny typing, not START HERE, while the snapshot loads', () => {
    renderFirstRun();

    // The first render is the one the old gate got wrong: no snapshot yet.
    expect(screen.queryByText('START HERE')).toBeNull();
    expect(screen.getByLabelText('Penny is typing')).toBeTruthy();
  });

  it('lands the greeting as a headline as soon as the snapshot does', async () => {
    renderFirstRun();

    // Well under the old 3s first-question delay: the fetch is 50ms.
    const headline = await screen.findByTestId('onboarding-headline', {}, { timeout: 1000 });
    expect(headline.textContent).toBe(GREETING);
    expect(screen.getByTestId('onboarding-prompt-city')).toBeTruthy();
    expect(screen.queryByLabelText('Penny is typing')).toBeNull();
    expect(screen.queryByText('START HERE')).toBeNull();
  });

  it('says the setup failed to load, and retries, instead of falling back to START HERE', async () => {
    snapshotFetch.fail = true;
    renderFirstRun();

    await screen.findByTestId('onboarding-load-error');
    expect(screen.queryByText('START HERE')).toBeNull();

    snapshotFetch.fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    await waitFor(() => expect(screen.queryByTestId('onboarding-headline')).not.toBeNull());
    expect(snapshotFetch.calls).toBe(2);
    expect(screen.queryByTestId('onboarding-load-error')).toBeNull();
  });
});
