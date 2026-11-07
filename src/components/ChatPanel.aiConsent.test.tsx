/**
 * The web panel asks before the first thing reaches Penny (App Review
 * 5.1.2(i)) — a typed setup answer, a suggestion chip — and sends nothing
 * on "Not now". The native panel runs the same shared controller
 * (src/lib/aiConsent.ts, unit-tested in aiConsent.test.ts) and is held to the
 * same call sites at source level by aiConsentClientGuard.test.ts; its sheet
 * is driven for real by the Maestro flows.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

const GREETING = "Where are we going? One city is enough to start — I'll sort the fuel.";
const SNAPSHOT = {
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

const server = vi.hoisted(() => ({
  consented: false,
  /** The sheet version agreed to; with `consented` true and this null, a server from before versions. */
  version: null as number | null,
  calls: [] as Array<{ path: string; method: string; body: unknown }>,
}));

vi.mock('@/lib/api', () => {
  class ApiError extends Error {
    status: number;
    payload: unknown;
    errorId: string | null = null;
    constructor(status: number, message: string, payload: unknown) {
      super(message);
      this.status = status;
      this.payload = payload;
    }
  }
  return {
    ApiError,
    apiFetch: vi.fn(async (path: string, opts: { method?: string; body?: unknown } = {}) => {
      const method = opts.method ?? (opts.body ? 'POST' : 'GET');
      server.calls.push({ path, method, body: opts.body });
      if (path === '/api/me') {
        return server.version === null
          ? { ai_consent: server.consented }
          : { ai_consent: server.consented, ai_consent_version: server.version };
      }
      if (path === '/api/me/preferences') {
        server.consented = true;
        server.version = (opts.body as { ai_consent_version?: number }).ai_consent_version ?? 1;
        return { ok: true, ai_consent: true, ai_consent_version: server.version };
      }
      if (path.includes('/onboarding') && method === 'GET') return SNAPSHOT;
      if (path.includes('/onboarding') && method === 'POST') {
        if (!server.consented) {
          throw new ApiError(403, 'consent', { code: 'ai_consent_required' });
        }
        return { next: SNAPSHOT, answerLabel: 'Girona to Lisbon', didHandoff: false };
      }
      return {};
    }),
  };
});

vi.mock('@/components/UnitsContext', () => ({ useUnits: () => ({ units: 'metric' }) }));
vi.mock('@/components/DeviceLocationContext', () => ({ useDeviceLocation: () => ({ place: null }) }));

import ChatPanel from '@/components/ChatPanel';
import { AI_CONSENT_COPY, AI_CONSENT_VERSION } from '@/lib/aiConsent';

const onboardingPosts = () => server.calls.filter((c) => c.path.includes('/onboarding') && c.method === 'POST');
const consentWrites = () => server.calls.filter((c) => c.path === '/api/me/preferences');

async function renderFirstRun() {
  render(<ChatPanel tripId="t1" initialMessages={[]} onboardingState="trip_intent" onTripUpdated={() => {}} />);
  await screen.findByTestId('onboarding-headline', {}, { timeout: 2000 });
  // Penny's intro typing holds the composer for a beat.
  await waitFor(
    () => expect((screen.getByTestId('trip-chat-composer') as HTMLTextAreaElement).disabled).toBe(false),
    { timeout: 5000 },
  );
}

function typeAndSend(text: string) {
  fireEvent.change(screen.getByTestId('trip-chat-composer'), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
}

describe('the AI consent dialog (web)', () => {
  beforeEach(() => {
    server.consented = false;
    server.version = null;
    server.calls = [];
    // /api/me/entitlement: an entitled trial, so the paywall leaves the composer open.
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ entitled: true, state: 'trial' }), { status: 200 })) as never;
    Element.prototype.scrollTo = vi.fn() as never;
  });
  afterEach(cleanup);

  it('the first setup answer waits for the dialog; Not now sends nothing and disables Penny', async () => {
    await renderFirstRun();
    typeAndSend('Girona to Lisbon');

    const dialog = await screen.findByTestId('ai-consent-sheet');
    expect(dialog.textContent).toContain('Penny uses Anthropic and TypeSafe');
    expect(dialog.textContent).toContain('your messages, any photos you attach, your trip details and your current location');
    expect(screen.getByTestId('ai-consent-typesafe').textContent).toBe(AI_CONSENT_COPY.typeSafeBody);
    // A new account is not told what "changed": it never saw the older sheet.
    expect(screen.queryByTestId('ai-consent-upgrade')).toBeNull();
    expect(screen.getByTestId('ai-consent-not-now').textContent).toBe('Not now');
    expect(onboardingPosts()).toEqual([]);

    fireEvent.click(screen.getByTestId('ai-consent-not-now'));
    await waitFor(() => expect(screen.queryByTestId('ai-consent-sheet')).toBeNull());
    expect(onboardingPosts()).toEqual([]);
    expect(consentWrites()).toEqual([]);
    expect(screen.getByTestId('ai-consent-declined').textContent).toContain("Penny can't plan");
    expect((screen.getByTestId('trip-chat-composer') as HTMLTextAreaElement).disabled).toBe(true);
    // What was typed survives the decline.
    expect((screen.getByTestId('trip-chat-composer') as HTMLTextAreaElement).value).toBe('Girona to Lisbon');

    // Review reopens it; Agree stores the agreement and only THEN may Penny be reached.
    fireEvent.click(screen.getByTestId('ai-consent-review'));
    fireEvent.click(await screen.findByTestId('ai-consent-agree'));
    await waitFor(() => expect(consentWrites()).toHaveLength(1));
    expect(consentWrites()[0]).toMatchObject({
      method: 'PATCH',
      body: { ai_consent: true, ai_consent_version: AI_CONSENT_VERSION },
    });
    await waitFor(() => expect(screen.queryByTestId('ai-consent-declined')).toBeNull());

    typeAndSend('Girona to Lisbon');
    await waitFor(() => expect(onboardingPosts()).toHaveLength(1));
    expect(screen.queryByTestId('ai-consent-sheet')).toBeNull();
  });

  it('Agree on the first answer sends that answer, after the agreement is stored', async () => {
    await renderFirstRun();
    typeAndSend('Girona to Lisbon');
    fireEvent.click(await screen.findByTestId('ai-consent-agree'));
    await waitFor(() => expect(onboardingPosts()).toHaveLength(1));
    const order = server.calls.map((c) => `${c.method} ${c.path}`);
    expect(order.indexOf('PATCH /api/me/preferences')).toBeLessThan(order.indexOf('POST /api/trips/t1/onboarding'));
    expect(onboardingPosts()[0].body).toMatchObject({ questionKey: 'trip_intent', value: 'Girona to Lisbon' });
  });

  it('tapping a suggestion chip asks first, and fills nothing on Not now', async () => {
    await renderFirstRun();
    fireEvent.click(screen.getByRole('button', { name: 'Pyrenees loop with 3 rest days' }));
    await screen.findByTestId('ai-consent-sheet');
    fireEvent.click(screen.getByTestId('ai-consent-not-now'));
    await waitFor(() => expect(screen.queryByTestId('ai-consent-sheet')).toBeNull());
    expect((screen.getByTestId('trip-chat-composer') as HTMLTextAreaElement).value).toBe('');
    expect(onboardingPosts()).toEqual([]);
  });

  it('an account that already agreed is never shown the dialog', async () => {
    server.consented = true;
    server.version = AI_CONSENT_VERSION;
    await renderFirstRun();
    typeAndSend('Girona to Lisbon');
    await waitFor(() => expect(onboardingPosts()).toHaveLength(1));
    expect(screen.queryByTestId('ai-consent-sheet')).toBeNull();
    expect(consentWrites()).toEqual([]);
  });

  it('an account on the Anthropic-only sheet is asked once; "Anthropic only" sends the answer and stores nothing', async () => {
    server.consented = true;
    server.version = 1;
    await renderFirstRun();
    typeAndSend('Girona to Lisbon');

    await screen.findByTestId('ai-consent-sheet');
    expect(screen.getByTestId('ai-consent-upgrade').textContent).toBe(AI_CONSENT_COPY.upgradeLead);
    expect(screen.getByTestId('ai-consent-not-now').textContent).toBe('Anthropic only');
    expect(onboardingPosts()).toEqual([]);

    fireEvent.click(screen.getByTestId('ai-consent-not-now'));
    // Penny keeps working on what was agreed: the answer goes, nothing is written,
    // and the composer is NOT disabled.
    await waitFor(() => expect(onboardingPosts()).toHaveLength(1));
    expect(consentWrites()).toEqual([]);
    expect(screen.queryByTestId('ai-consent-declined')).toBeNull();
  });

  it('an account on the Anthropic-only sheet that agrees stores version 2, then sends', async () => {
    server.consented = true;
    server.version = 1;
    await renderFirstRun();
    typeAndSend('Girona to Lisbon');
    fireEvent.click(await screen.findByTestId('ai-consent-agree'));
    await waitFor(() => expect(onboardingPosts()).toHaveLength(1));
    expect(consentWrites()[0].body).toEqual({ ai_consent: true, ai_consent_version: AI_CONSENT_VERSION });
    const order = server.calls.map((c) => `${c.method} ${c.path}`);
    expect(order.indexOf('PATCH /api/me/preferences')).toBeLessThan(order.indexOf('POST /api/trips/t1/onboarding'));
  });

  it('a server from before versions ("ai_consent: true" alone) reads as the Anthropic-only sheet', async () => {
    server.consented = true;
    server.version = null;
    await renderFirstRun();
    typeAndSend('Girona to Lisbon');
    await screen.findByTestId('ai-consent-upgrade');
  });
});
