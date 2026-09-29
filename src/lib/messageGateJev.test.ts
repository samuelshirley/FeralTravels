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
 */

const h = vi.hoisted(() => {
  const inserted: Array<Record<string, unknown>> = [];
  const state = { failInsert: false };
  // A drizzle stand-in: every chain resolves to [], and `.values(row)` is
  // captured so the real `logJevUsage` can be asserted on.
  const chain: unknown = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === 'then') return (resolve: (v: unknown[]) => void) => resolve([]);
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
  return { chain, inserted, state };
});

vi.mock('server-only', () => ({}));
vi.mock('@/server/db/client', () => ({ db: h.chain }));
vi.mock('@/server/payments', () => ({ GATE_PROVIDER: 'penny:gate' }));
vi.mock('@/server/repos/users', () => ({
  getStrikeState: vi.fn(),
  setStrikeState: vi.fn(async () => undefined),
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

import { gateMessage } from '@/server/messageGate';
import { classifyMessage } from '@/server/pennyClassifier';
import { effectiveJevMode, jevModeFromValue, jevOverrideFromValue, resolveJevMode } from '@/server/repos/jev';
import { getStrikeState, setStrikeState } from '@/server/repos/users';
import { logUsageEvent } from '@/server/repos/usage';
import { buildClassifyContent, CLASSIFY_SYSTEM } from '@/lib/pennyClassifierPrompt';
import { decideDeterministically, type MessageTier } from '@/lib/pennyGate';

/** Nothing on the trip and no trip vocabulary, so it reaches the classifier. */
const MESSAGE = 'is there anywhere with a proper cheeseburger around here';
const USER = 'user-1';
const TRIP = '00000000-0000-0000-0000-000000000001';

function jevBody(choice: string, probabilities: Record<string, number>) {
  return {
    model: 'laya-rl-agent',
    answers: { tier: { type: 'choice', choice, probabilities, confidence: 0.1 } },
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

function useFetch(impl: (url: string, init: RequestInit) => Promise<Response>) {
  fetchMock = vi.fn(impl);
  vi.stubGlobal('fetch', fetchMock);
}

async function run(strikes = 0) {
  vi.mocked(getStrikeState).mockResolvedValue({ strikes, lockedUntil: null });
  return gateMessage({ userId: USER, tripId: TRIP, message: MESSAGE });
}

function jevRows() {
  return h.inserted.filter((r) => r.provider === 'jev');
}

function gateRow() {
  const calls = vi.mocked(logUsageEvent).mock.calls.filter(([a]) => a.provider === 'penny:gate');
  expect(calls).toHaveLength(1);
  return calls[0][0];
}

beforeEach(() => {
  h.inserted.length = 0;
  h.state.failInsert = false;
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
  it('only exactly "on" is on, globally', () => {
    expect(jevModeFromValue('on')).toBe('on');
    for (const v of ['ON', '1', 'true', 'yes', ' on', '', null, undefined]) {
      expect(jevModeFromValue(v), String(v)).toBe('off');
    }
  });

  it('a per-user value is on, off, or follows the global', () => {
    expect(jevOverrideFromValue('on')).toBe('on');
    expect(jevOverrideFromValue('off')).toBe('off');
    for (const v of ['ON', 'Off', '1', '', null, undefined]) {
      expect(jevOverrideFromValue(v), String(v)).toBeNull();
    }
  });

  it('the user override wins over the global switch, both ways', () => {
    expect(resolveJevMode('off', null)).toEqual({ mode: 'off', source: 'global' });
    expect(resolveJevMode('on', null)).toEqual({ mode: 'on', source: 'global' });
    expect(resolveJevMode('off', 'on')).toEqual({ mode: 'on', source: 'user' });
    expect(resolveJevMode('on', 'off')).toEqual({ mode: 'off', source: 'user' });
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
