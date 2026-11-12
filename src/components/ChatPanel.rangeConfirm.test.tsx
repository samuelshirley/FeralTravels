/**
 * The one-tap range confirm (Sam, 2026-11-11): "about 600 km a tank" with no
 * vehicle named, on an account whose Hilux says 500 km, is asked as "Use 600 km
 * for the Hilux?". The server builds it as an ordinary `select` step; this
 * proves the web panel draws both answers as chips and posts the tapped value —
 * the units step's path, not a new one. The native panel renders `select`
 * through the same tap-to-answer kinds (src/lib/onboardingForm.ts) and is held
 * to them at source level.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

const CONFIRM = {
  state: 'vehicle_new',
  question: {
    key: 'range_confirm',
    kind: 'select',
    label: 'Use 600 km for the Hilux?',
    options: [
      { value: 'yes', label: 'Yes, use 600 km' },
      { value: 'no', label: 'No, keep 500 km' },
    ],
  },
  vehicles: [],
  progress: { current: 2, total: 2 },
};

const server = vi.hoisted(() => ({ calls: [] as Array<{ path: string; method: string; body: unknown }> }));

vi.mock('@/lib/api', () => {
  class ApiError extends Error {
    status = 500;
    payload: unknown = null;
    errorId: string | null = null;
  }
  return {
    ApiError,
    apiFetch: vi.fn(async (path: string, opts: { method?: string; body?: unknown } = {}) => {
      const method = opts.method ?? (opts.body ? 'POST' : 'GET');
      server.calls.push({ path, method, body: opts.body });
      if (path === '/api/me') return { ai_consent: true, ai_consent_version: 99 };
      if (path.includes('/onboarding') && method === 'GET') return CONFIRM;
      if (path.includes('/onboarding') && method === 'POST') {
        return { next: { state: 'done', question: null, vehicles: [], progress: null }, answerLabel: 'Yes, use 600 km', didHandoff: false };
      }
      return {};
    }),
  };
});
vi.mock('@/components/UnitsContext', () => ({ useUnits: () => ({ units: 'metric' }) }));
vi.mock('@/components/DeviceLocationContext', () => ({ useDeviceLocation: () => ({ place: null }) }));

import ChatPanel from '@/components/ChatPanel';

describe('the range confirm step (web)', () => {
  beforeEach(() => {
    server.calls = [];
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ entitled: true, state: 'trial' }), { status: 200 })) as never;
    Element.prototype.scrollTo = vi.fn() as never;
  });
  afterEach(cleanup);

  it('shows both answers as chips and posts the tapped one', async () => {
    render(<ChatPanel tripId="t1" initialMessages={[]} onboardingState="vehicle_new" onTripUpdated={() => {}} />);
    const yes = await screen.findByRole('button', { name: 'Yes, use 600 km' }, { timeout: 5000 });
    expect(screen.getByRole('button', { name: 'No, keep 500 km' })).toBeTruthy();
    expect(screen.getByText('Use 600 km for the Hilux?')).toBeTruthy();

    await waitFor(() => expect((yes as HTMLButtonElement).disabled).toBe(false), { timeout: 5000 });
    fireEvent.click(yes);

    await waitFor(() => {
      const posts = server.calls.filter((c) => c.path.includes('/onboarding') && c.method === 'POST');
      expect(posts.map((p) => p.body)).toEqual([{ questionKey: 'range_confirm', value: 'yes' }]);
    });
  });
});
