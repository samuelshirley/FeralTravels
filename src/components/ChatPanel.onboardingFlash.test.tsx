/**
 * A REPRO OF AN UNFIXED BUG, held as `it.fails` so it can live on a branch
 * without redding CI: the first-run chat paints the `START HERE` empty state
 * for as long as the onboarding snapshot fetch is in flight, then swaps it for
 * the onboarding card.
 *
 * `it.fails` passes while the bug is present and FAILS THE SUITE the moment
 * somebody fixes it — which is the point. A `.skip` would rot silently and a
 * plain `it` would block every PR this branch touches until the flash is gone.
 * When it goes red, delete this line and the `.fails`, and it becomes the
 * guard that keeps the flash from coming back.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import React from 'react';

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(async (path: string) => {
    if (path.includes('/onboarding')) {
      // Resolve on a later macrotask, like a real network round trip.
      await new Promise((r) => setTimeout(r, 50));
      return {
        state: 'trip_intent',
        question: {
          key: 'trip_intent',
          kind: 'text',
          label: "Where are we going? One city is enough to start — I'll sort the fuel.",
          prompts: ['Paris to Stuttgart, 5 h days', 'Pyrenees loop with 3 rest days'],
        },
        vehicles: [],
        progress: { step: 1, total: 5 },
      };
    }
    return {};
  }),
}));

vi.mock('@/components/UnitsContext', () => ({ useUnits: () => ({ units: 'metric' }) }));
vi.mock('@/components/DeviceLocationContext', () => ({ useDeviceLocation: () => ({ place: null }) }));

import ChatPanel from '@/components/ChatPanel';

describe('first-run onboarding', () => {
  beforeEach(() => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })) as never;
  });

  it.fails('does not paint the START HERE empty state while the snapshot loads', async () => {
    render(
      <ChatPanel
        tripId="t1"
        initialMessages={[]}
        onboardingState="trip_intent"
        onTripUpdated={() => {}}
      />
    );

    const sawStarter = screen.queryByText('START HERE') !== null;
    // eslint-disable-next-line no-console
    console.log('[repro] START HERE painted on first render:', sawStarter);

    await waitFor(() => expect(screen.queryByTestId('onboarding-progress')).not.toBeNull(), {
      timeout: 3000,
    });

    expect(sawStarter, 'START HERE must not paint during onboarding').toBe(false);
  });
});
