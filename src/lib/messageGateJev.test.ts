import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The message gate with Jev in front of Haiku — every outcome, end to end
 * through `gateMessage()`, with the network and Haiku mocked.
 *
 * What this pins, in order of how much it would cost to lose:
 *
 *  1. Jev can only ever SETTLE a confident T1. A T2, a T3, an unsure T1, any
 *     HTTP error, a timeout, bad JSON, a throw, no config: Haiku is called and
 *     Haiku's answer is the tier — including the strike it does or does not
 *     earn. Nothing strikes a driver on Jev's word.
 *  2. Mode off makes ZERO network calls and is Haiku, as today.
 *  3. The Jev row in `usage_events` carries no user text.
 *  4. Jev rows count toward no cap, limit, breaker or trial ceiling.
 *  5. COMPARE mode: Haiku decides every message exactly as mode off, Jev is
 *     asked at the same moment, and its answer is only written down — beside
 *     Haiku's tier, never instead of it. And /admin's reading of those rows.
 *  6. CONSENT: nothing reaches TypeSafe for an account that has not agreed to
 *     the sheet naming it (version 2). A version-1 account is Haiku only in
 *     every mode — zero fetch calls — and so is a forged proof.
 *  7. The ROUTE question (compare only): asked in the same request as the
 *     tier, asked ALONE for a message the free rules let through, logged with
 *     no user text, and never able to change a decision.
 */

const h = vi.hoisted(() => {
  const inserted: Array<Record<string, unknown>> = [];
  const wheres: unknown[] = [];
  const state: { failInsert: boolean; results: unknown[][] } = { failInsert: false, results: [] };
  // A drizzle stand-in: every chain resolves to the next queued result (or
  // []), `.where(x)` is captured so the admin queries' filters can be read,
  // and `.values(row)` is captured so the real `logJevUsage` can be asserted on.
  const chain: unknown = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === 'then') {
        return (resolve: (v: unknown[]) => void) => resolve(state.results.shift() ?? []);
      }
      if (prop === 'where') {
        return (w: unknown) => {
          wheres.push(w);
          return chain;
        };
      }
      if (prop === 'values') {
        return (row: Record<string, unknown>) => {
          if (state.failInsert) throw new Error('insert failed');
          inserted.push(row);
          return chain;
        };
      }
      return () => chain;
    },
    apply() {
      return chain;
    },
  });
  return { chain, inserted, wheres, state };
});

vi.mock('server-only', () => ({}));
vi.mock('@/server/db/client', () => ({ db: h.chain }));
vi.mock('@/server/payments', () => ({ GATE_PROVIDER: 'penny:gate' }));
vi.mock('@/server/repos/users', () => ({
  getStrikeState: vi.fn(),
  setStrikeState: vi.fn(async () => undefined),
  getAiConsent: vi.fn(),
}));
vi.mock('@/server/repos/usage', () => ({
  JEV_PROVIDER: 'jev',
  logUsageEvent: vi.fn(async () => undefined),
  microcentsToDollars: (m: number) => m / 100_000_000,
}));
vi.mock('@/server/pennyClassifier', () => ({ classifyMessage: vi.fn() }));
vi.mock('@/server/repos/jev', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/server/repos/jev')>();
  return { ...real, effectiveJevMode: vi.fn() };
});

import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

import { gateMessage, type GateOutcome } from '@/server/messageGate';
import { requireAiConsent, type AiConsentProof } from '@/server/aiConsent';
import { classifyMessage } from '@/server/pennyClassifier';
import {
  effectiveJevMode,
  getJevCompareStats,
  getJevStats,
  jevModeFromValue,
  jevOverrideFromValue,
  resolveJevMode,
  summariseJevCompare,
  summariseJevRoutes,
  type JevRouteGroup,
} from '@/server/repos/jev';
import { getAiConsent, getStrikeState, setStrikeState } from '@/server/repos/users';
import { logUsageEvent } from '@/server/repos/usage';
import { buildClassifyContent, CLASSIFY_SYSTEM } from '@/lib/pennyClassifierPrompt';
import { JEV_ROUTE_CRITERIA, JEV_ROUTE_INSTRUCTIONS, JEV_ROUTES } from '@/lib/jevRoute';
import { decideDeterministically, type MessageTier } from '@/lib/pennyGate';

/** Nothing on the trip and no trip vocabulary, so it reaches the classifier. */
const MESSAGE = 'is there anywhere with a proper cheeseburger around here';
const USER = 'user-1';
const TRIP = '00000000-0000-0000-0000-000000000001';

/** A backend answers every question it was asked; a tier-only request just ignores `route`. */
function jevBody(
  choice: string,
  probabilities: Record<string, number>,
  route: { choice: string; probabilities: Record<string, number> } = {
    choice: 'needs_penny',
    probabilities: { needs_penny: 0.9, add_pasted_place: 0.05, replace_fuel_stop: 0.03, off_topic: 0.02 },
  },
) {
  return {
    model: 'laya-rl-agent',
    answers: {
      tier: { type: 'choice', choice, probabilities, confidence: 0.1 },
      route: { type: 'choice', ...route },
    },
    usage: { input_tokens: 92, output_tokens: 0 },
  };
}

const ok = (body: unknown) => async () => new Response(JSON.stringify(body), { status: 200 });

function haikuSays(tier: MessageTier) {
  vi.mocked(classifyMessage).mockResolvedValue({
    tier,
    by: 'classifier',
    reason: `haiku ${tier}`,
    microcents: 135_200,
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

/**
 * A REAL proof, minted by `requireAiConsent` over the mocked consent read, for
 * an account that agreed to the sheet naming TypeSafe (version 2) unless a
 * test says otherwise. A cast would not do: the gate only asks Jev under a
 * proof `src/server/aiConsent.ts` minted.
 */
let CONSENT: AiConsentProof;
async function consentAt(version: number | null): Promise<AiConsentProof> {
  vi.mocked(getAiConsent).mockResolvedValue({ at: new Date('2026-11-01T00:00:00Z'), version });
  return requireAiConsent(USER);
}

function useFetch(impl: (url: string, init: RequestInit) => Promise<Response>) {
  fetchMock = vi.fn(impl);
  vi.stubGlobal('fetch', fetchMock);
}

async function run(strikes = 0) {
  vi.mocked(getStrikeState).mockResolvedValue({ strikes, lockedUntil: null });
  return gateMessage({ userId: USER, tripId: TRIP, message: MESSAGE, consent: CONSENT });
}

function jevRows() {
  return h.inserted.filter((r) => r.provider === 'jev');
}

function gateRow() {
  const calls = vi.mocked(logUsageEvent).mock.calls.filter(([a]) => a.provider === 'penny:gate');
  expect(calls).toHaveLength(1);
  return calls[0][0];
}

beforeEach(async () => {
  h.inserted.length = 0;
  h.wheres.length = 0;
  h.state.failInsert = false;
  h.state.results = [];
  vi.clearAllMocks();
  vi.stubEnv('JEV_BASE_URL', 'https://jev.example.test');
  vi.stubEnv('JEV_API_KEY', 'test-key');
  vi.stubEnv('JEV_MODEL', '');
  vi.stubEnv('JEV_TIMEOUT_MS', '');
  vi.stubEnv('JEV_T1_MIN', '');
  vi.stubEnv('VERCEL_ENV', '');
  vi.stubEnv('CI', '');
  vi.mocked(effectiveJevMode).mockResolvedValue({ mode: 'on', source: 'global' });
  useFetch(ok(jevBody('T1', { T1: 0.95, T2: 0.03, T3: 0.02 })));
  CONSENT = await consentAt(2);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it('the fixture message really does reach the classifier path', () => {
  expect(decideDeterministically({ message: MESSAGE, tripNames: [], recentMessages: [] })).toBeNull();
});

describe('mode off', () => {
  it('makes zero fetch calls, writes no Jev row, and Haiku decides', async () => {
    vi.mocked(effectiveJevMode).mockResolvedValue({ mode: 'off', source: 'global' });
    haikuSays('T3');
    const out = await run();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(classifyMessage).toHaveBeenCalledTimes(1);
    expect(jevRows()).toHaveLength(0);
    expect(out).toMatchObject({ tier: 'T3', by: 'classifier', reason: 'haiku T3', blocked: true });
    expect(setStrikeState).toHaveBeenCalledWith(USER, expect.objectContaining({ strikes: 1 }));
  });

  it('a per-user OFF holds the account on Haiku while the global switch is on', async () => {
    vi.mocked(effectiveJevMode).mockResolvedValue({ mode: 'off', source: 'user' });
    haikuSays('T1');
    await run();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('Jev settles a confident T1', () => {
  it('skips Haiku, lets the message through and resets strikes', async () => {
    const out = await run(2);
    expect(classifyMessage).not.toHaveBeenCalled();
    expect(out).toMatchObject({ tier: 'T1', by: 'classifier', blocked: false, message: null });
    expect(out.reason).toMatch(/^jev T1 p=0\.95$/);
    expect(setStrikeState).toHaveBeenCalledWith(USER, expect.objectContaining({ strikes: 0 }));
    expect(gateRow()).toMatchObject({ model: 'T1', success: true });
    expect(jevRows()).toHaveLength(1);
    expect(jevRows()[0]).toMatchObject({
      provider: 'jev',
      costMicrocents: 0,
      success: true,
      inputTokens: 92,
      outputTokens: 0,
      meta: { settled: true, choice: 'T1', top: 0.95, margin: 0.92, deferredReason: null, mode: 'global' },
    });
  });

  it('asks the Haiku question, with the bearer key, at /v1/systemone', async () => {
    await run();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://jev.example.test/v1/systemone');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-key');
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('typed-decisions');
    expect(body.state).toBe(buildClassifyContent(MESSAGE, { tripName: null, places: [] }));
    expect(body.questions.tier.type).toBe('choice');
    expect(body.questions.tier.instructions).toBe(CLASSIFY_SYSTEM);
    expect(Object.keys(body.questions.tier.criteria)).toEqual(['T1', 'T2', 'T3']);
  });

  it('honours JEV_MODEL from the environment', async () => {
    vi.stubEnv('JEV_MODEL', 'my-model');
    await run();
    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.model).toBe('my-model');
  });
});

/**
 * Every case where Jev must NOT decide. For each: Haiku is called exactly
 * once, the tier and the strike are Haiku's, and one Jev row records why.
 */
const deferrals: Array<{
  name: string;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  env?: Record<string, string>;
  reason: string;
  success: boolean;
}> = [
  { name: 'low confidence T1', fetch: ok(jevBody('T1', { T1: 0.8, T2: 0.15, T3: 0.05 })), reason: 'below_t1_min', success: true },
  { name: 'narrow lead', fetch: ok(jevBody('T1', { T1: 0.55, T2: 0.4, T3: 0.05 })), env: { JEV_T1_MIN: '0.5' }, reason: 'margin', success: true },
  { name: 'confident T2', fetch: ok(jevBody('T2', { T1: 0.01, T2: 0.98, T3: 0.01 })), reason: 'not_t1', success: true },
  { name: 'confident T3', fetch: ok(jevBody('T3', { T1: 0.001, T2: 0.001, T3: 0.998 })), reason: 'not_t1', success: true },
  { name: '401', fetch: async () => new Response('{"error":"no"}', { status: 401 }), reason: 'http_401', success: false },
  { name: '422', fetch: async () => new Response('{}', { status: 422 }), reason: 'http_422', success: false },
  { name: '429', fetch: async () => new Response('{}', { status: 429 }), reason: 'http_429', success: false },
  { name: '529', fetch: async () => new Response('{}', { status: 529 }), reason: 'http_529', success: false },
  {
    name: 'timeout',
    env: { JEV_TIMEOUT_MS: '20' },
    fetch: (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        );
      }),
    reason: 'timeout',
    success: false,
  },
  { name: 'malformed JSON', fetch: async () => new Response('{"answers": {', { status: 200 }), reason: 'bad_json', success: false },
  { name: 'fetch throws', fetch: async () => { throw new TypeError('fetch failed'); }, reason: 'network', success: false },
  { name: 'choice outside the enum', fetch: ok(jevBody('T4', { T4: 1 })), reason: 'schema', success: false },
  { name: 'choice not the most probable', fetch: ok(jevBody('T1', { T1: 0.2, T2: 0.1, T3: 0.7 })), reason: 'schema', success: false },
  { name: 'no config', fetch: ok(jevBody('T1', { T1: 1 })), env: { JEV_BASE_URL: '' }, reason: 'not_configured', success: false },
  { name: 'local host under CI', fetch: ok(jevBody('T1', { T1: 1 })), env: { JEV_BASE_URL: 'http://127.0.0.1:8000', CI: 'true' }, reason: 'not_configured', success: false },
];

describe.each(deferrals)('Jev defers: $name', ({ fetch, env, reason, success }) => {
  beforeEach(() => {
    useFetch(fetch);
    for (const [k, v] of Object.entries(env ?? {})) vi.stubEnv(k, v);
  });

  it.each(['T1', 'T2', 'T3'] as const)('Haiku %s is final', async (haikuTier) => {
    haikuSays(haikuTier);
    const out = await run(1);

    expect(classifyMessage).toHaveBeenCalledTimes(1);
    expect(out.tier).toBe(haikuTier);
    expect(out.by).toBe('classifier');
    expect(out.reason).toBe(`haiku ${haikuTier}`);
    expect(out.blocked).toBe(haikuTier !== 'T1');
    expect(gateRow()).toMatchObject({ model: haikuTier });

    // The strike is Haiku's: T3 adds one, T1 resets, T2 leaves it alone.
    if (haikuTier === 'T3') {
      expect(setStrikeState).toHaveBeenCalledWith(USER, expect.objectContaining({ strikes: 2 }));
    } else if (haikuTier === 'T1') {
      expect(setStrikeState).toHaveBeenCalledWith(USER, expect.objectContaining({ strikes: 0 }));
    } else {
      expect(setStrikeState).not.toHaveBeenCalled();
    }

    const rows = jevRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ provider: 'jev', costMicrocents: 0, success });
    expect(rows[0].meta).toMatchObject({ settled: false, deferredReason: reason });
    if (reason === 'not_configured') expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('a confident Jev T3 never strikes on its own', () => {
  it('Haiku overrules it to T1: no strike, message through', async () => {
    useFetch(ok(jevBody('T3', { T1: 0, T2: 0, T3: 1 })));
    haikuSays('T1');
    const out = await run(2);
    expect(out).toMatchObject({ tier: 'T1', blocked: false, lockedUntil: null });
    expect(setStrikeState).toHaveBeenCalledWith(USER, expect.objectContaining({ strikes: 0 }));
  });
});

describe('bookkeeping never refuses a message', () => {
  it('a failed Jev row write still settles', async () => {
    h.state.failInsert = true;
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = await run();
    expect(out.tier).toBe('T1');
    expect(classifyMessage).not.toHaveBeenCalled();
    expect(spy).toHaveBeenCalledWith('[repos/jev] could not record the Jev call', expect.any(Error));
    spy.mockRestore();
  });
});

describe('the Jev row carries no user text', () => {
  it('meta is exactly the eight whitelisted keys, and the message appears nowhere in the row', async () => {
    // A backend that echoes the message back in every field it controls.
    useFetch(
      ok({
        model: MESSAGE,
        answers: { tier: { type: 'choice', choice: 'T2', probabilities: { T2: 1 }, note: MESSAGE } },
        usage: { input_tokens: 5, output_tokens: 0 },
        echo: MESSAGE,
      }),
    );
    haikuSays('T1');
    await run();
    const [row] = jevRows();
    expect(Object.keys(row.meta as object).sort()).toEqual(
      ['choice', 'deferredReason', 'echoedModel', 'latencyMs', 'margin', 'mode', 'settled', 'top'].sort(),
    );
    // An echoed model that is not shaped like a model id is dropped, not stored.
    expect((row.meta as { echoedModel: unknown }).echoedModel).toBeNull();
    expect(JSON.stringify(row)).not.toContain('cheeseburger');
  });

  it('error rows carry no response body', async () => {
    useFetch(async () => new Response(JSON.stringify({ error: MESSAGE }), { status: 422 }));
    haikuSays('T1');
    await run();
    expect(JSON.stringify(jevRows()[0])).not.toContain('cheeseburger');
  });
});

describe('the switch rules', () => {
  it('only exactly "on" or "compare" is not off, globally', () => {
    expect(jevModeFromValue('on')).toBe('on');
    expect(jevModeFromValue('compare')).toBe('compare');
    for (const v of ['ON', 'COMPARE', 'Compare', ' compare', '1', 'true', 'yes', ' on', '', null, undefined]) {
      expect(jevModeFromValue(v), String(v)).toBe('off');
    }
  });

  it('a per-user value is on, compare, off, or follows the global', () => {
    expect(jevOverrideFromValue('on')).toBe('on');
    expect(jevOverrideFromValue('compare')).toBe('compare');
    expect(jevOverrideFromValue('off')).toBe('off');
    for (const v of ['ON', 'Off', 'COMPARE', '1', '', null, undefined]) {
      expect(jevOverrideFromValue(v), String(v)).toBeNull();
    }
  });

  it('the user override wins over the global switch, every way', () => {
    expect(resolveJevMode('off', null)).toEqual({ mode: 'off', source: 'global' });
    expect(resolveJevMode('on', null)).toEqual({ mode: 'on', source: 'global' });
    expect(resolveJevMode('compare', null)).toEqual({ mode: 'compare', source: 'global' });
    expect(resolveJevMode('off', 'on')).toEqual({ mode: 'on', source: 'user' });
    expect(resolveJevMode('on', 'off')).toEqual({ mode: 'off', source: 'user' });
    expect(resolveJevMode('on', 'compare')).toEqual({ mode: 'compare', source: 'user' });
    expect(resolveJevMode('compare', 'off')).toEqual({ mode: 'off', source: 'user' });
  });
});

/**
 * Jev rows are $0 and must not eat anyone's limits. Held at the source: each
 * reader either excludes `jev` by name or only counts `anthropic%` (and
 * `'jev'` does not start with `anthropic`).
 */
describe('jev rows count toward no cap, limit, breaker or trial ceiling', () => {
  const read = (p: string) => readFileSync(join(__dirname, '..', '..', p), 'utf8');

  it('the hourly request limit and daily $ cap exclude them by name', () => {
    const src = read('src/server/repos/usage.ts');
    const fn = src.slice(src.indexOf('export async function getUserUsageSummary'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    expect(body).toMatch(/ne\(usageEvents\.provider, JEV_PROVIDER\)/);
    expect(src).toMatch(/export const JEV_PROVIDER = 'jev';/);
  });

  it('the 12-month cap, trial ceiling and spend breakers count anthropic% only', () => {
    expect('jev'.startsWith('anthropic')).toBe(false);
    expect(read('src/server/payments/usage.ts')).toMatch(/LIKE 'anthropic%'/);
    const breakers = read('src/server/payments/breakerCheck.ts');
    expect(breakers).toMatch(/\$\{usageEvents\.provider\} LIKE 'anthropic%'/);
    expect(read('src/server/payments/testAccounts.ts')).toMatch(/LIKE 'anthropic%'/);
  });
});

// ── Compare mode ────────────────────────────────────────────────────────────

describe('compare mode: Haiku decides, Jev is only written down', () => {
  beforeEach(() => {
    vi.mocked(effectiveJevMode).mockResolvedValue({ mode: 'compare', source: 'global' });
  });

  it('a confident Jev T1 (0.99) against a Haiku T3: T3, the strike, Haiku called', async () => {
    useFetch(ok(jevBody('T1', { T1: 0.99, T2: 0.005, T3: 0.005 })));
    haikuSays('T3');
    const out = await run(1);

    expect(classifyMessage).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ tier: 'T3', by: 'classifier', reason: 'haiku T3', blocked: true });
    expect(setStrikeState).toHaveBeenCalledWith(USER, expect.objectContaining({ strikes: 2 }));
    expect(gateRow()).toMatchObject({ model: 'T3', errorMessage: 'T3 by classifier: haiku T3' });

    const rows = jevRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      provider: 'jev',
      costMicrocents: 0,
      success: true,
      meta: { mode: 'compare', choice: 'T1', top: 0.99, wouldSettle: true, settled: false, haikuTier: 'T3', agree: false },
    });
  });

  it('the reverse: a confident Jev T3 against a Haiku T1: T1, no strike', async () => {
    useFetch(ok(jevBody('T3', { T1: 0.005, T2: 0.005, T3: 0.99 })));
    haikuSays('T1');
    const out = await run(2);

    expect(classifyMessage).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ tier: 'T1', by: 'classifier', reason: 'haiku T1', blocked: false, lockedUntil: null });
    expect(setStrikeState).toHaveBeenCalledWith(USER, expect.objectContaining({ strikes: 0 }));
    expect(jevRows()[0].meta).toMatchObject({ choice: 'T3', wouldSettle: false, haikuTier: 'T1', agree: false });
  });

  it('agreeing with Haiku changes nothing either: the decision is still Haiku\'s', async () => {
    useFetch(ok(jevBody('T1', { T1: 0.99, T2: 0.005, T3: 0.005 })));
    haikuSays('T1');
    const out = await run();
    expect(classifyMessage).toHaveBeenCalledTimes(1);
    expect(out.reason).toBe('haiku T1');
  });

  it('asks Jev and Haiku at the same moment: the fetch is out before Haiku answers', async () => {
    let releaseHaiku!: () => void;
    let fetchesWhenHaikuAsked = -1;
    vi.mocked(classifyMessage).mockImplementation(() => {
      fetchesWhenHaikuAsked = fetchMock.mock.calls.length;
      return new Promise((resolve) => {
        releaseHaiku = () => resolve({ tier: 'T2', by: 'classifier', reason: 'haiku T2', microcents: 1 });
      });
    });
    vi.mocked(getStrikeState).mockResolvedValue({ strikes: 0, lockedUntil: null });
    const pending = gateMessage({ userId: USER, tripId: TRIP, message: MESSAGE, consent: CONSENT });

    await vi.waitFor(() => expect(classifyMessage).toHaveBeenCalledTimes(1));
    expect(fetchesWhenHaikuAsked).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    releaseHaiku();
    const out = await pending;
    expect(out.tier).toBe('T2');
    expect(jevRows()[0].meta).toMatchObject({ haikuTier: 'T2', choice: 'T1', agree: false });
  });

  it('waits for a Jev answer that lands after Haiku, inside Jev\'s timeout', async () => {
    useFetch(
      () =>
        new Promise<Response>((resolve) =>
          setTimeout(() => resolve(new Response(JSON.stringify(jevBody('T2', { T1: 0.1, T2: 0.8, T3: 0.1 })))), 15),
        ),
    );
    haikuSays('T2');
    await run();
    expect(jevRows()[0]).toMatchObject({ success: true, meta: { choice: 'T2', haikuTier: 'T2', agree: true } });
  });

  it('never waits past Jev\'s own timeout, even for a backend that ignores the abort', async () => {
    vi.stubEnv('JEV_TIMEOUT_MS', '30');
    useFetch(() => new Promise<Response>(() => {})); // never answers, never rejects
    haikuSays('T3');
    const started = Date.now();
    const out = await run(1);
    expect(Date.now() - started).toBeLessThan(500);
    expect(out).toMatchObject({ tier: 'T3', reason: 'haiku T3' });
    expect(jevRows()[0]).toMatchObject({
      success: false,
      meta: { mode: 'compare', deferredReason: 'timeout', choice: null, wouldSettle: false, haikuTier: 'T3', agree: false },
    });
  });

  /**
   * A Jev failure in compare mode is one `success: false` row and nothing
   * else: the outcome, the strike write and the gate row are byte for byte
   * what mode off produces for the same Haiku answer.
   */
  const failures: Array<{ name: string; fetch: (url: string, init: RequestInit) => Promise<Response>; env?: Record<string, string>; reason: string }> = [
    { name: 'HTTP 422', fetch: async () => new Response('{}', { status: 422 }), reason: 'http_422' },
    { name: 'HTTP 529', fetch: async () => new Response('{}', { status: 529 }), reason: 'http_529' },
    { name: 'network error', fetch: async () => { throw new TypeError('fetch failed'); }, reason: 'network' },
    { name: 'bad JSON', fetch: async () => new Response('{"answers": {', { status: 200 }), reason: 'bad_json' },
    {
      name: 'timeout',
      env: { JEV_TIMEOUT_MS: '20' },
      fetch: (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        }),
      reason: 'timeout',
    },
    { name: 'no config', fetch: ok(jevBody('T1', { T1: 1 })), env: { JEV_BASE_URL: '' }, reason: 'not_configured' },
  ];

  describe.each(failures)('Jev fails ($name)', ({ fetch, env, reason }) => {
    it.each(['T1', 'T2', 'T3'] as const)('the outcome is mode off\'s, for Haiku %s', async (haikuTier) => {
      for (const [k, v] of Object.entries(env ?? {})) vi.stubEnv(k, v);

      async function once(mode: 'off' | 'compare') {
        vi.clearAllMocks();
        h.inserted.length = 0;
        vi.mocked(effectiveJevMode).mockResolvedValue({ mode, source: 'global' });
        useFetch(fetch);
        haikuSays(haikuTier);
        const out: GateOutcome = await run(1);
        return {
          out,
          strikes: vi.mocked(setStrikeState).mock.calls,
          gate: gateRow(),
          haikuCalls: vi.mocked(classifyMessage).mock.calls.length,
          jev: jevRows(),
        };
      }

      const off = await once('off');
      const compare = await once('compare');

      expect(compare.out).toEqual(off.out);
      expect(compare.strikes).toEqual(off.strikes);
      expect(compare.gate).toEqual(off.gate);
      expect(compare.haikuCalls).toBe(1);
      expect(off.jev).toHaveLength(0);
      expect(compare.jev).toHaveLength(1);
      expect(compare.jev[0]).toMatchObject({
        provider: 'jev',
        success: false,
        meta: { mode: 'compare', deferredReason: reason, wouldSettle: false, haikuTier, agree: false },
      });
    });
  });

  it.each([
    ['confident T1', jevBody('T1', { T1: 0.99, T2: 0.005, T3: 0.005 }), 'T1', { wouldSettle: true, agree: true }],
    ['unsure T1', jevBody('T1', { T1: 0.6, T2: 0.3, T3: 0.1 }), 'T1', { wouldSettle: false, agree: true }],
    ['T2 vs T2', jevBody('T2', { T1: 0.1, T2: 0.8, T3: 0.1 }), 'T2', { wouldSettle: false, agree: true }],
    ['T3 vs T3', jevBody('T3', { T1: 0.05, T2: 0.05, T3: 0.9 }), 'T3', { wouldSettle: false, agree: true }],
    ['T2 vs T3', jevBody('T2', { T1: 0.1, T2: 0.8, T3: 0.1 }), 'T3', { wouldSettle: false, agree: false }],
    ['confident T1 vs T2', jevBody('T1', { T1: 0.95, T2: 0.03, T3: 0.02 }), 'T2', { wouldSettle: true, agree: false }],
  ] as const)('meta for %s: haikuTier, agree and wouldSettle', async (_name, body, haikuTier, want) => {
    useFetch(ok(body));
    haikuSays(haikuTier);
    await run();
    expect(jevRows()[0].meta).toMatchObject({ mode: 'compare', source: 'global', haikuTier, ...want });
  });

  it('a per-user compare row records where the mode came from', async () => {
    vi.mocked(effectiveJevMode).mockResolvedValue({ mode: 'compare', source: 'user' });
    haikuSays('T1');
    await run();
    expect(jevRows()[0].meta).toMatchObject({ mode: 'compare', source: 'user' });
  });

  it('the compare row is exactly its whitelisted keys, and no user text', async () => {
    useFetch(
      ok({
        model: MESSAGE,
        answers: {
          tier: { type: 'choice', choice: 'T2', probabilities: { T2: 1 }, note: MESSAGE },
          route: { type: 'choice', choice: 'off_topic', probabilities: { off_topic: 1 }, note: MESSAGE, why: MESSAGE },
        },
        usage: { input_tokens: 5, output_tokens: 0 },
        echo: MESSAGE,
      }),
    );
    haikuSays('T2');
    await run();
    const [row] = jevRows();
    expect(Object.keys(row.meta as object).sort()).toEqual(COMPARE_KEYS);
    expect(row.meta).toMatchObject({
      haikuTier: 'T2',
      agree: true,
      wouldSettle: false,
      echoedModel: null,
      route: 'off_topic',
      truth: 'off_topic',
    });
    expect(JSON.stringify(row)).not.toContain('cheeseburger');
  });

  it('a backend that puts the message IN the route choice gets a null route, not the text', async () => {
    useFetch(
      ok({
        model: 'm',
        answers: {
          tier: { type: 'choice', choice: 'T1', probabilities: { T1: 1 } },
          route: { type: 'choice', choice: MESSAGE, probabilities: { [MESSAGE]: 1 } },
        },
        usage: { input_tokens: 5, output_tokens: 0 },
      }),
    );
    haikuSays('T1');
    await run();
    const [row] = jevRows();
    expect(row).toMatchObject({ success: false, meta: { route: null, routeConfident: false, choice: 'T1' } });
    expect(JSON.stringify(row)).not.toContain('cheeseburger');
  });
});

/** Every key a compare row's meta carries at write time. */
const COMPARE_KEYS = [
  'agree', 'choice', 'deferredReason', 'echoedModel', 'gateBy', 'haikuMicrocents', 'haikuTier',
  'latencyMs', 'margin', 'mode', 'route', 'routeConfident', 'routeMargin', 'routeTop', 'settled',
  'source', 'tierAsked', 'tierConfident', 'top', 'truth', 'wouldSettle',
].sort();

// ── Consent: nothing reaches TypeSafe without the sheet that names it ──────

describe('consent version 1 (the Anthropic-only sheet): Jev is never called', () => {
  it.each(['on', 'compare'] as const)('mode %s: zero fetch calls, no Jev row, Haiku decides', async (mode) => {
    vi.mocked(effectiveJevMode).mockResolvedValue({ mode, source: 'global' });
    CONSENT = await consentAt(null); // agreed before versions: reads as 1
    expect(CONSENT.version).toBe(1);
    haikuSays('T3');
    const out = await run(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(jevRows()).toHaveLength(0);
    expect(classifyMessage).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ tier: 'T3', reason: 'haiku T3', jevCompareEventId: null });
    // The switch is not even read for an account TypeSafe may not see.
    expect(effectiveJevMode).not.toHaveBeenCalled();
  });

  it('a message the free rules let through: no route question either', async () => {
    vi.mocked(effectiveJevMode).mockResolvedValue({ mode: 'compare', source: 'global' });
    CONSENT = await consentAt(1);
    vi.mocked(getStrikeState).mockResolvedValue({ strikes: 0, lockedUntil: null });
    const out = await gateMessage({ userId: USER, tripId: TRIP, message: FREE_T1, consent: CONSENT });
    expect(out).toMatchObject({ tier: 'T1', by: 'allow_rule' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(jevRows()).toHaveLength(0);
  });

  it('a forged proof (a cast, not minted) is treated as no TypeSafe consent', async () => {
    vi.mocked(effectiveJevMode).mockResolvedValue({ mode: 'compare', source: 'global' });
    CONSENT = Object.freeze({ userId: USER, version: 2 }) as unknown as AiConsentProof;
    haikuSays('T1');
    await run();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(jevRows()).toHaveLength(0);
  });

  it('version 2 is what lets Jev be asked at all', async () => {
    vi.mocked(effectiveJevMode).mockResolvedValue({ mode: 'compare', source: 'global' });
    CONSENT = await consentAt(2);
    haikuSays('T1');
    await run();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// ── The route question (compare only, measurement only) ─────────────────────

/** "fuel" is trip vocabulary: the free rules let it through with no classifier. */
const FREE_T1 = 'find me a different fuel station for tomorrow';

describe('the route question', () => {
  beforeEach(() => {
    vi.mocked(effectiveJevMode).mockResolvedValue({ mode: 'compare', source: 'global' });
  });

  it('the free-rule fixture really is decided by the free rules', () => {
    expect(decideDeterministically({ message: FREE_T1, tripNames: [], recentMessages: [] })).toMatchObject({
      tier: 'T1',
      by: 'allow_rule',
    });
  });

  it('on the classifier path: ONE request carries the tier AND the route question', async () => {
    haikuSays('T1');
    await run();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(Object.keys(body.questions).sort()).toEqual(['route', 'tier']);
    expect(body.questions.route.type).toBe('choice');
    expect(body.questions.route.instructions).toBe(JEV_ROUTE_INSTRUCTIONS);
    expect(body.questions.route.criteria).toEqual(JEV_ROUTE_CRITERIA);
    expect(Object.keys(body.questions.route.criteria)).toEqual([...JEV_ROUTES]);
    // The same state the tier question has always had — nothing more of the trip.
    expect(body.state).toBe(buildClassifyContent(MESSAGE, { tripName: null, places: [] }));
  });

  it('Jev-first (mode on) still asks the tier question alone', async () => {
    vi.mocked(effectiveJevMode).mockResolvedValue({ mode: 'on', source: 'global' });
    await run();
    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(Object.keys(body.questions)).toEqual(['tier']);
  });

  it('records the route, its confidence, the measured Haiku cost, and off_topic truth from Haiku', async () => {
    useFetch(
      ok(
        jevBody('T2', { T1: 0.02, T2: 0.96, T3: 0.02 }, {
          choice: 'off_topic',
          probabilities: { off_topic: 0.93, needs_penny: 0.05, add_pasted_place: 0.01, replace_fuel_stop: 0.01 },
        }),
      ),
    );
    haikuSays('T2');
    const out = await run();
    expect(out.tier).toBe('T2');
    expect(jevRows()[0]).toMatchObject({
      inputTokens: 92,
      meta: {
        gateBy: 'classifier',
        tierAsked: true,
        choice: 'T2',
        tierConfident: true,
        haikuTier: 'T2',
        haikuMicrocents: 135_200,
        route: 'off_topic',
        routeTop: 0.93,
        routeMargin: 0.88,
        routeConfident: true,
        truth: 'off_topic',
      },
    });
  });

  it('a Haiku T1 leaves the truth to the turn (null until it ends)', async () => {
    haikuSays('T1');
    await run();
    expect(jevRows()[0].meta).toMatchObject({ haikuTier: 'T1', truth: null });
  });

  it('a message the free rules let through: the ROUTE question alone, logged, the decision untouched', async () => {
    useFetch(
      ok({
        model: 'jev-1.13.0',
        answers: {
          route: {
            type: 'choice',
            choice: 'replace_fuel_stop',
            probabilities: { replace_fuel_stop: 0.9, needs_penny: 0.08, add_pasted_place: 0.01, off_topic: 0.01 },
          },
        },
        usage: { input_tokens: 61, output_tokens: 0 },
      }),
    );
    vi.mocked(getStrikeState).mockResolvedValue({ strikes: 1, lockedUntil: null });
    const out = await gateMessage({ userId: USER, tripId: TRIP, message: FREE_T1, consent: CONSENT });

    expect(out).toMatchObject({ tier: 'T1', by: 'allow_rule', blocked: false });
    expect(classifyMessage).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(Object.keys(body.questions)).toEqual(['route']);

    const [row] = jevRows();
    expect(Object.keys(row.meta as object).sort()).toEqual(COMPARE_KEYS);
    expect(row).toMatchObject({
      success: true,
      inputTokens: 61,
      model: 'jev-1.13.0',
      meta: {
        gateBy: 'allow_rule',
        tierAsked: false,
        choice: null,
        haikuTier: null,
        agree: false,
        wouldSettle: false,
        tierConfident: false,
        haikuMicrocents: null,
        route: 'replace_fuel_stop',
        routeConfident: true,
        truth: null,
      },
    });
    expect(JSON.stringify(row)).not.toContain('fuel station');
  });

  it('Jev-first (mode on) does not ask anything about a message the free rules let through', async () => {
    vi.mocked(effectiveJevMode).mockResolvedValue({ mode: 'on', source: 'global' });
    vi.mocked(getStrikeState).mockResolvedValue({ strikes: 0, lockedUntil: null });
    await gateMessage({ userId: USER, tripId: TRIP, message: FREE_T1, consent: CONSENT });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a route answer cannot change any decision: every route, every Haiku tier', async () => {
    for (const route of JEV_ROUTES) {
      for (const tier of ['T1', 'T2', 'T3'] as const) {
        vi.clearAllMocks();
        h.inserted.length = 0;
        vi.mocked(effectiveJevMode).mockResolvedValue({ mode: 'compare', source: 'global' });
        useFetch(ok(jevBody(tier, { [tier]: 1 }, { choice: route, probabilities: { [route]: 1 } })));
        haikuSays(tier);
        const out = await run(1);
        expect(out, `${route}/${tier}`).toMatchObject({ tier, reason: `haiku ${tier}`, blocked: tier !== 'T1' });
      }
    }
  });

  it('a route-only call that fails is one success:false row and the message goes through', async () => {
    useFetch(async () => new Response('{}', { status: 529 }));
    vi.mocked(getStrikeState).mockResolvedValue({ strikes: 0, lockedUntil: null });
    const out = await gateMessage({ userId: USER, tripId: TRIP, message: FREE_T1, consent: CONSENT });
    expect(out).toMatchObject({ tier: 'T1', blocked: false });
    expect(jevRows()).toHaveLength(1);
    expect(jevRows()[0]).toMatchObject({ success: false, meta: { route: null, deferredReason: 'http_529' } });
  });

  it('a route-only call never waits past Jev\'s own timeout', async () => {
    vi.stubEnv('JEV_TIMEOUT_MS', '30');
    useFetch(() => new Promise<Response>(() => {}));
    vi.mocked(getStrikeState).mockResolvedValue({ strikes: 0, lockedUntil: null });
    const started = Date.now();
    const out = await gateMessage({ userId: USER, tripId: TRIP, message: FREE_T1, consent: CONSENT });
    expect(Date.now() - started).toBeLessThan(500);
    expect(out.tier).toBe('T1');
    expect(jevRows()[0]).toMatchObject({ success: false, meta: { deferredReason: 'timeout' } });
  });
});

// ── /admin's reading of the compare rows ────────────────────────────────────

const dialect = new PgDialect();
const whereSql = (i: number) => dialect.sqlToQuery(h.wheres[i] as SQL).sql;

describe('the compare stats', () => {
  const groups = [
    // haikuTier, choice, wouldSettle, success, timedOut, n
    { haikuTier: 'T1', choice: 'T1', wouldSettle: true, success: true, timedOut: false, n: 120 },
    { haikuTier: 'T1', choice: 'T1', wouldSettle: false, success: true, timedOut: false, n: 20 },
    { haikuTier: 'T1', choice: 'T2', wouldSettle: false, success: true, timedOut: false, n: 8 },
    { haikuTier: 'T1', choice: 'T3', wouldSettle: false, success: true, timedOut: false, n: 2 },
    { haikuTier: 'T2', choice: 'T1', wouldSettle: true, success: true, timedOut: false, n: 4 },
    { haikuTier: 'T2', choice: 'T1', wouldSettle: false, success: true, timedOut: false, n: 2 },
    { haikuTier: 'T2', choice: 'T2', wouldSettle: false, success: true, timedOut: false, n: 22 },
    { haikuTier: 'T2', choice: 'T3', wouldSettle: false, success: true, timedOut: false, n: 2 },
    { haikuTier: 'T3', choice: 'T1', wouldSettle: true, success: true, timedOut: false, n: 1 },
    { haikuTier: 'T3', choice: 'T2', wouldSettle: false, success: true, timedOut: false, n: 1 },
    { haikuTier: 'T3', choice: 'T3', wouldSettle: false, success: true, timedOut: false, n: 10 },
    { haikuTier: 'T1', choice: null, wouldSettle: false, success: false, timedOut: true, n: 5 },
    { haikuTier: 'T3', choice: null, wouldSettle: false, success: false, timedOut: false, n: 3 },
  ];

  it('reads only compare rows, and sums them into the table and the headline', async () => {
    h.state.results = [groups, [{ p50: 87.6, p95: 300.2 }]];
    const s = await getJevCompareStats(7);

    expect(whereSql(0)).toContain(`"usage_events"."meta"->>'mode' = 'compare'`);
    expect(whereSql(0)).toContain(`"usage_events"."provider" = $`);
    // Route-only rows (free-rule messages) have no Haiku tier to compare.
    expect(whereSql(0)).toContain(`COALESCE("usage_events"."meta"->>'tierAsked', 'true') = 'true'`);
    expect(whereSql(1)).toContain(`->>'mode' = 'compare'`);

    expect(s).toMatchObject({
      days: 7,
      compared: 200,
      answered: 192,
      errors: 8,
      timeouts: 5,
      agreed: 172,
      wouldSettle: 125,
      wouldPassHaikuRefused: 5,
      wouldPassHaikuT2: 4,
      wouldPassHaikuT3: 1,
      haikuT1: 155,
      haikuT1WouldSettle: 120,
      p50Ms: 88,
      p95Ms: 300,
    });
    expect(s.matrix).toEqual({
      T1: { T1: 140, T2: 8, T3: 2 },
      T2: { T1: 6, T2: 22, T3: 2 },
      T3: { T1: 1, T2: 1, T3: 10 },
    });
  });

  it('an unknown label is counted as compared and nowhere in the table', () => {
    const s = summariseJevCompare(
      [{ haikuTier: 'T1', choice: 'T4', wouldSettle: false, success: true, timedOut: false, n: 3 }],
      7,
    );
    expect(s).toMatchObject({ compared: 3, answered: 0, agreed: 0 });
    expect(s.matrix.T1).toEqual({ T1: 0, T2: 0, T3: 0 });
  });

  it('Jev-first stats leave the compare rows out: Jev settled none of them', async () => {
    await getJevStats(7);
    expect(whereSql(0)).toContain(`COALESCE("usage_events"."meta"->>'mode', '') <> 'compare'`);
  });
});

describe('the route stats (summariseJevRoutes)', () => {
  const g = (patch: Partial<JevRouteGroup>): JevRouteGroup => ({
    route: null,
    routeConfident: false,
    truth: null,
    turnStatus: null,
    tierAsked: false,
    haikuTier: null,
    choice: null,
    tierConfident: false,
    dayParseKind: null,
    dayMatch: null,
    n: 1,
    pennyCostRows: 0,
    pennyMicrocents: 0,
    haikuMicrocents: 0,
    ...patch,
    // A group's tokens are its rows' SUM, as the SQL reads them: 70 a call.
    inputTokens: 70 * (patch.n ?? 1),
  });

  it('precision and coverage per route, and dollars only from correct, confident routes', () => {
    const s = summariseJevRoutes(
      [
        // Right, confident, costed: $0.08 + $0.10 of Penny avoided.
        g({ route: 'add_pasted_place', routeConfident: true, truth: 'add_pasted_place', turnStatus: 'done', n: 2, pennyCostRows: 2, pennyMicrocents: 18_000_000 }),
        // Right but NOT confident: counts toward the truth, not the route or the dollars.
        g({ route: 'add_pasted_place', routeConfident: false, truth: 'add_pasted_place', turnStatus: 'done', pennyCostRows: 1, pennyMicrocents: 9_000_000 }),
        // Confident and wrong.
        g({ route: 'add_pasted_place', routeConfident: true, truth: 'needs_penny', turnStatus: 'done', pennyCostRows: 1, pennyMicrocents: 9_000_000 }),
        // No truth yet: ungraded, out of every rate.
        g({ route: 'replace_fuel_stop', routeConfident: true, truth: null, turnStatus: null }),
        // Errored turn: out, and counted as such.
        g({ route: 'replace_fuel_stop', routeConfident: true, truth: null, turnStatus: 'error' }),
        // No route answer at all.
        g({ route: null }),
      ],
      7,
    );
    const add = s.intents.find((i) => i.route === 'add_pasted_place')!;
    expect(add).toMatchObject({ routedConfident: 3, correctConfident: 2, truthCount: 3, costedRows: 2 });
    expect(add.avoidedUsd).toBeCloseTo(0.18, 10);
    expect(s).toMatchObject({ compared: 7, answered: 6, graded: 4, ungraded: 1, erroredTurns: 1, avgInputTokens: 70 });
    expect(s.intents.find((i) => i.route === 'replace_fuel_stop')).toMatchObject({ routedConfident: 0, avoidedUsd: 0 });
  });

  it('case 1: confident T2/T3 against Haiku, and the gate-only saving from the measured Haiku calls', () => {
    const s = summariseJevRoutes(
      [
        g({ tierAsked: true, choice: 'T3', tierConfident: true, haikuTier: 'T3', truth: 'off_topic', route: 'off_topic', routeConfident: true, n: 3, haikuMicrocents: 405_600 }),
        g({ tierAsked: true, choice: 'T2', tierConfident: true, haikuTier: 'T1', truth: null, route: 'needs_penny' }),
        g({ tierAsked: true, choice: 'T2', tierConfident: true, haikuTier: 'T3', truth: 'off_topic', route: 'off_topic', routeConfident: true, haikuMicrocents: 135_200 }),
        // Not confident: not a confident refusal.
        g({ tierAsked: true, choice: 'T3', tierConfident: false, haikuTier: 'T3', truth: 'off_topic' }),
      ],
      7,
    );
    expect(s.gateOnly).toMatchObject({ confidentRefusals: 5, agreed: 3, haikuSaidT1: 1, otherRefusalTier: 1 });
    expect(s.gateOnly.avoidedUsd).toBeCloseTo(0.004056, 10);
    // The route view of the same rows: off_topic routes graded by Haiku's refusal.
    const off = s.intents.find((i) => i.route === 'off_topic')!;
    expect(off).toMatchObject({ routedConfident: 4, correctConfident: 4, truthCount: 4 });
    expect(off.avoidedUsd).toBeCloseTo(0.005408, 10);
  });

  it('case 2: the free day parse against the day Penny chose', () => {
    const s = summariseJevRoutes(
      [
        g({ route: 'add_pasted_place', truth: 'add_pasted_place', turnStatus: 'done', dayParseKind: 'day_number', dayMatch: true, n: 4 }),
        g({ route: 'add_pasted_place', truth: 'add_pasted_place', turnStatus: 'done', dayParseKind: 'date', dayMatch: false }),
        g({ route: 'add_pasted_place', truth: 'add_pasted_place', turnStatus: 'done', dayParseKind: 'none', dayMatch: null, n: 2 }),
      ],
      7,
    );
    expect(s.day).toEqual({ graded: 5, matched: 4, byKind: { day_number: 4, date: 1, none: 2 } });
  });
});
