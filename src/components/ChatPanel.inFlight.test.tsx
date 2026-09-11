/**
 * A FRESH MOUNT of the chat panel, with a turn already in flight for that trip,
 * shows that Penny is working.
 *
 * ── The bug, as measured ──────────────────────────────────────────────────
 *
 * Reproduced on an iOS simulator, 2026-09-11. With a turn running, leaving the
 * trip (SETTINGS, then CHAT, then back into the trip) and returning to the chat
 * gave a panel whose header read READY, with no typing bubble and no planning
 * clip. The server's own record disagreed:
 *
 *     12:51:48  penny_turns.status = running
 *     12:51:49  screenshot: header pill reads READY
 *     12:52:10  live view hierarchy: one text node, 'READY'; no 'THINKING'
 *     12:52:11  penny_turns.status = running
 *
 * Both halves of the indicator were screen-local `useState` — `loading` here
 * and `thinking` in TripWorkspace — and both start `false`. A new mount could
 * therefore never show a turn it had not itself sent, on a turn that routinely
 * runs 60-90 seconds. The driver's only signal that anything was happening was
 * gone, which reads as an app that has died.
 *
 * ── Why this file is the one that would have caught it ────────────────────
 *
 * Every other test of this panel starts by SENDING something, so `loading` is
 * true and the indicator renders for the wrong reason. The defining property of
 * the bug is that nothing was sent from this mount: the turn belongs to a mount
 * that no longer exists, and the panel has to find out from somewhere else.
 * Both routes into that state are covered below — the in-process store, and a
 * cold mount that knows nothing and must ask the server.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, waitFor, within } from '@testing-library/react';
import React from 'react';
import type { ChatMessage } from '@/types/trip';
import { beginPennyRun, isPennyRunning, resetPennyRuns } from '@/lib/pennyRunStore';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn(async () => ({})) }));
vi.mock('@/components/UnitsContext', () => ({ useUnits: () => ({ units: 'metric' }) }));
vi.mock('@/components/DeviceLocationContext', () => ({ useDeviceLocation: () => ({ place: null }) }));

import ChatPanel from '@/components/ChatPanel';
import { apiFetch } from '@/lib/api';

const TRIP = 'trip-in-flight';
const TURN_KEY = 'turn-abcdefgh';

/** The user's message, which the server persists BEFORE the turn runs. */
const messages: ChatMessage[] = [
  {
    seq: 1,
    id: 'm1',
    trip_id: TRIP,
    role: 'user',
    content: 'Replan the whole trip',
    kind: 'ai',
    changes_made: null,
    plan_summary: null,
    form_meta: null,
  } as ChatMessage,
];

function renderPanel(tripId = TRIP) {
  return render(
    <ChatPanel
      tripId={tripId}
      initialMessages={messages}
      onboardingState={undefined}
      onTripUpdated={() => {}}
    />
  );
}

describe('a fresh mount with a turn in flight', () => {
  beforeEach(() => {
    resetPennyRuns();
    vi.mocked(apiFetch).mockReset();
    // Default: the server has no turn to report. Individual tests override.
    vi.mocked(apiFetch).mockImplementation(async () => ({ turn: null }) as never);
    global.fetch = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })) as never;
  });
  /*
   * Explicit. `src/test/setup.ts` loads jest-dom's matchers and nothing else —
   * there is no auto-cleanup — so without this each render stacks another
   * panel into the same document and every query finds two of everything.
   */
  afterEach(() => {
    cleanup();
    resetPennyRuns();
  });

  it('reads THINKING, not READY, when the store says a run is live', async () => {
    beginPennyRun(TRIP, TURN_KEY);
    const view = renderPanel();
    await waitFor(() =>
      expect(within(view.container).getByTestId('penny-status').textContent).toContain('THINKING')
    );
    expect(within(view.container).getByTestId('penny-status').textContent).not.toContain('READY');
  });

  it('shows the typing bubble, so the transcript agrees with the header', async () => {
    beginPennyRun(TRIP, TURN_KEY);
    const view = renderPanel();
    await waitFor(() => expect(within(view.container).getByLabelText('Penny is typing')).toBeTruthy());
  });

  /**
   * The cold case, and the one the store alone cannot answer: a page that has
   * just loaded knows nothing, so it has to ask. This is what a phone does
   * after the app is killed, and what a browser does on a hard reload.
   */
  it('asks the server on mount and believes it over its own empty store', async () => {
    vi.mocked(apiFetch).mockImplementation((async (path: string) => {
      if (String(path).includes('/turns')) {
        return { turn: { status: 'running', idempotency_key: TURN_KEY } };
      }
      return {};
    }) as never);

    expect(isPennyRunning(TRIP)).toBe(false);
    const view = renderPanel();
    await waitFor(() =>
      expect(within(view.container).getByTestId('penny-status').textContent).toContain('THINKING')
    );
  });

  /**
   * `queued` is a turn waiting behind another. It is work the user is waiting
   * on, so READY is exactly as wrong for it as it is for `running`.
   */
  it('counts a queued turn as in flight', async () => {
    vi.mocked(apiFetch).mockImplementation((async (path: string) => {
      if (String(path).includes('/turns')) {
        return { turn: { status: 'queued', idempotency_key: TURN_KEY } };
      }
      return {};
    }) as never);
    const view = renderPanel();
    await waitFor(() =>
      expect(within(view.container).getByTestId('penny-status').textContent).toContain('THINKING')
    );
  });

  // ── the other direction, so this is not just "always say THINKING" ───────

  it('reads READY when nothing is running', async () => {
    const view = renderPanel();
    await waitFor(() =>
      expect(within(view.container).getByTestId('penny-status').textContent).toContain('READY')
    );
    expect(within(view.container).queryByLabelText('Penny is typing')).toBeNull();
  });

  it('is keyed by trip — another trip’s run does not light this one up', async () => {
    beginPennyRun('some-other-trip', TURN_KEY);
    const view = renderPanel();
    await waitFor(() =>
      expect(within(view.container).getByTestId('penny-status').textContent).toContain('READY')
    );
  });
});
