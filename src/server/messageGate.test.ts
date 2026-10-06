import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The gate hands Penny's previous message to every decider that judges the
 * driver's message: the free reply rule, Haiku, and Jev. Without it a bare
 * "yes do that" was refused as junk with a strike, Jev on or off.
 */

// A drizzle stand-in: every query resolves to no rows (no trip names, no
// recent messages), so only the mocked chat read below supplies anything.
const h = vi.hoisted(() => {
  const chain: unknown = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === 'then') return (resolve: (v: unknown[]) => void) => resolve([]);
      return () => chain;
    },
    apply() {
      return chain;
    },
  });
  return { chain };
});

vi.mock('server-only', () => ({}));
vi.mock('@/server/db/client', () => ({ db: h.chain }));
vi.mock('@/server/payments', () => ({ GATE_PROVIDER: 'penny:gate' }));
vi.mock('@/server/repos/chat', () => ({ previousAssistantMessage: vi.fn() }));
vi.mock('@/server/repos/users', () => ({
  getStrikeState: vi.fn(async () => ({ strikes: 0, lockedUntil: null })),
  setStrikeState: vi.fn(async () => undefined),
}));
vi.mock('@/server/repos/usage', () => ({ logUsageEvent: vi.fn(async () => undefined) }));
vi.mock('@/server/pennyClassifier', () => ({ classifyMessage: vi.fn() }));
vi.mock('@/server/repos/jev', () => ({ effectiveJevMode: vi.fn(), logJevUsage: vi.fn(async () => undefined) }));
vi.mock('@/server/jev', () => ({ jevClassifyTier: vi.fn(), startJevClassifyTier: vi.fn() }));

import { gateMessage } from './messageGate';
import { previousAssistantMessage } from '@/server/repos/chat';
import { logUsageEvent } from '@/server/repos/usage';
import { classifyMessage } from '@/server/pennyClassifier';
import { effectiveJevMode } from '@/server/repos/jev';
import { jevClassifyTier } from '@/server/jev';

const PENNY = 'I can push the start back a day, so day 1 is Saturday. Want me to do that?';
const run = (message: string) => gateMessage({ userId: 'u1', tripId: 't1', message });

function gateRowText() {
  const calls = vi.mocked(logUsageEvent).mock.calls.filter(([a]) => a.provider === 'penny:gate');
  expect(calls).toHaveLength(1);
  return calls[0][0].errorMessage;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(effectiveJevMode).mockResolvedValue({ mode: 'off', source: 'global' });
  vi.mocked(classifyMessage).mockResolvedValue({ tier: 'T1', by: 'classifier', reason: 'haiku T1', microcents: 1 });
  vi.mocked(jevClassifyTier).mockResolvedValue({
    settled: false,
    choice: 'T1',
    top: 0.7,
    margin: 0.5,
    latencyMs: 200,
    deferredReason: 'below_t1_min',
    echoedModel: null,
    inputTokens: 1,
    outputTokens: 0,
    success: true,
    errorMessage: null,
  });
});

describe('a bare reply straight after Penny', () => {
  it('is let through by the free rule: no model is asked, nothing is struck', async () => {
    vi.mocked(previousAssistantMessage).mockResolvedValue(PENNY);
    const out = await run('yes do that');
    expect(out).toMatchObject({ tier: 'T1', by: 'allow_rule', blocked: false });
    expect(gateRowText()).toBe('T1 by allow_rule: reply to Penny');
    expect(classifyMessage).not.toHaveBeenCalled();
    expect(jevClassifyTier).not.toHaveBeenCalled();
  });

  it('is still judged by the classifier when Penny has not spoken', async () => {
    vi.mocked(previousAssistantMessage).mockResolvedValue(null);
    await run('yes do that');
    expect(classifyMessage).toHaveBeenCalledTimes(1);
    expect(vi.mocked(classifyMessage).mock.calls[0][1]).toMatchObject({ previousAssistant: null });
  });
});

describe("Penny's previous message reaches the classifiers", () => {
  // Not a bare reply, so it goes past the free rules.
  const MESSAGE = 'hmm, what about the other way round';

  it('Haiku is given it', async () => {
    vi.mocked(previousAssistantMessage).mockResolvedValue(PENNY);
    await run(MESSAGE);
    expect(vi.mocked(classifyMessage).mock.calls[0][1]).toMatchObject({ previousAssistant: PENNY });
  });

  it('Jev is given it, in Jev-first mode, and so is Haiku when Jev defers', async () => {
    vi.mocked(effectiveJevMode).mockResolvedValue({ mode: 'on', source: 'user' });
    vi.mocked(previousAssistantMessage).mockResolvedValue(PENNY);
    await run(MESSAGE);
    expect(vi.mocked(jevClassifyTier).mock.calls[0][1]).toMatchObject({ previousAssistant: PENNY });
    expect(vi.mocked(classifyMessage).mock.calls[0][1]).toMatchObject({ previousAssistant: PENNY });
  });
});
