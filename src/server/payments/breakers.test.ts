import { describe, expect, it } from 'vitest';

import {
  evaluateBreakers,
  evaluateGate,
  levelFor,
  retryAfterFor,
  worstLevel,
  type BreakerFacts,
  type BreakerSpec,
} from './breakers';
import { BREAKERS, dollars } from './constants';

/**
 * The breakers are the only thing bounding the bill, so every threshold edge is
 * asserted rather than assumed — including the ones that look obvious. The bug
 * this shape is guarding against is not a wrong comparison operator on its own;
 * it is a wrong operator nobody notices because the breaker never fires in
 * testing and the first real evidence is a Console total.
 */

const CLOSED: BreakerFacts = {
  anthropicMicrocents24h: 0,
  anthropicMicrocents1h: 0,
  signups1h: 0,
  signups24h: 0,
  gatedMessages1h: 0,
  manualLock: false,
  factsUnavailable: false,
};

function facts(over: Partial<BreakerFacts> = {}): BreakerFacts {
  return { ...CLOSED, ...over };
}

function statusOf(id: string, f: BreakerFacts) {
  const found = evaluateBreakers(f, BREAKERS).find((s) => s.id === id);
  if (!found) throw new Error(`no breaker ${id}`);
  return found;
}

describe('levelFor', () => {
  it('is ok below the alert line', () => {
    expect(levelFor(9, 10, 25)).toBe('ok');
  });

  it('alerts AT the alert line, not one past it', () => {
    expect(levelFor(10, 10, 25)).toBe('alert');
  });

  it('opens AT the stop line, not one past it', () => {
    expect(levelFor(25, 10, 25)).toBe('open');
  });

  it('stays alert between the two lines', () => {
    expect(levelFor(24, 10, 25)).toBe('alert');
  });

  it('never opens a breaker with no stop line, however large the value', () => {
    expect(levelFor(1_000_000, 10, null)).toBe('alert');
  });
});

describe('the configured thresholds', () => {
  it('are the numbers the design says: $10/$25 a day, $3/$8 an hour', () => {
    const day = statusOf('anthropic_spend_24h', CLOSED);
    expect(day.alertAt).toBe(dollars(10));
    expect(day.stopAt).toBe(dollars(25));
    const hour = statusOf('anthropic_spend_1h', CLOSED);
    expect(hour.alertAt).toBe(dollars(3));
    expect(hour.stopAt).toBe(dollars(8));
  });

  it('are 50/100 sign-ups an hour and 100/200 a day', () => {
    expect(statusOf('signups_1h', CLOSED).stopAt).toBe(100);
    expect(statusOf('signups_24h', CLOSED).stopAt).toBe(200);
  });

  it('leave the junk-message breaker alert-only', () => {
    // If this ever gains a stop line, read the comment on it in constants.ts
    // first: stopping on junk punishes the drivers, not the bot.
    expect(statusOf('gated_messages_1h', CLOSED).stopAt).toBeNull();
  });

  it('put every spend and lock breaker on the penny gate and sign-ups on their own', () => {
    // A spend flood must never stop people signing IN, and a sign-up flood must
    // never strand a driver mid-trip. The gate field is what keeps them apart.
    const byId = Object.fromEntries(BREAKERS.map((b) => [b.id, b.gate]));
    expect(byId.anthropic_spend_24h).toBe('penny');
    expect(byId.anthropic_spend_1h).toBe('penny');
    expect(byId.manual_lock).toBe('penny');
    expect(byId.gated_messages_1h).toBe('penny');
    expect(byId.signups_1h).toBe('signup');
    expect(byId.signups_24h).toBe('signup');
  });
});

describe('evaluateBreakers', () => {
  it('reports everything ok on an idle app', () => {
    for (const s of evaluateBreakers(CLOSED, BREAKERS)) expect(s.level).toBe('ok');
  });

  it('alerts on $10 of spend in a day without stopping anybody', () => {
    const s = statusOf('anthropic_spend_24h', facts({ anthropicMicrocents24h: dollars(10) }));
    expect(s.level).toBe('alert');
    expect(evaluateGate('penny', facts({ anthropicMicrocents24h: dollars(10) }), BREAKERS).blocked)
      .toBe(false);
  });

  it('opens on $25 of spend in a day', () => {
    expect(statusOf('anthropic_spend_24h', facts({ anthropicMicrocents24h: dollars(25) })).level)
      .toBe('open');
  });

  it('opens the hourly breaker at $8 even though the day is nowhere near $25', () => {
    // The whole reason the 1h breaker exists: $8 in an hour is a spike, and
    // waiting for the daily line to notice is waiting until tomorrow.
    const f = facts({ anthropicMicrocents1h: dollars(8), anthropicMicrocents24h: dollars(9) });
    expect(statusOf('anthropic_spend_24h', f).level).toBe('ok');
    expect(evaluateGate('penny', f, BREAKERS).breaker).toBe('anthropic_spend_1h');
  });

  it('treats the manual lock as thrown or not, never as a count', () => {
    expect(statusOf('manual_lock', CLOSED).level).toBe('ok');
    expect(statusOf('manual_lock', facts({ manualLock: true })).level).toBe('open');
  });
});

describe('evaluateGate', () => {
  it('lets everything through on an idle app', () => {
    expect(evaluateGate('penny', CLOSED, BREAKERS).blocked).toBe(false);
    expect(evaluateGate('signup', CLOSED, BREAKERS).blocked).toBe(false);
  });

  it('does not let a spend flood close sign-in', () => {
    const f = facts({ anthropicMicrocents24h: dollars(9999) });
    expect(evaluateGate('penny', f, BREAKERS).blocked).toBe(true);
    expect(evaluateGate('signup', f, BREAKERS).blocked).toBe(false);
  });

  it('does not let a sign-up flood strand a driver mid-trip', () => {
    const f = facts({ signups1h: 5000, signups24h: 5000 });
    expect(evaluateGate('signup', f, BREAKERS).blocked).toBe(true);
    expect(evaluateGate('penny', f, BREAKERS).blocked).toBe(false);
  });

  it('never blocks on the alert-only breaker', () => {
    const f = facts({ gatedMessages1h: 100_000 });
    expect(statusOf('gated_messages_1h', f).level).toBe('alert');
    expect(evaluateGate('penny', f, BREAKERS).blocked).toBe(false);
  });

  it('REFUSES when the facts could not be read', () => {
    // Fails closed, which is the opposite of the paywall switch and is the
    // single most important line in this file: a database in trouble is when an
    // attack is most likely to be underway, and a gate that opens on a failed
    // read is a gate with a documented bypass.
    const v = evaluateGate('penny', facts({ factsUnavailable: true }), BREAKERS);
    expect(v.blocked).toBe(true);
    expect(v.breaker).toBe('facts_unavailable');
    expect(evaluateGate('signup', facts({ factsUnavailable: true }), BREAKERS).blocked).toBe(true);
  });

  it('refuses on unreadable facts even when every measured number is fine', () => {
    expect(evaluateGate('penny', { ...CLOSED, factsUnavailable: true }, BREAKERS).blocked).toBe(true);
  });

  it('names the breaker that did it', () => {
    expect(evaluateGate('penny', facts({ manualLock: true }), BREAKERS).breaker).toBe('manual_lock');
    expect(evaluateGate('signup', facts({ signups24h: 200 }), BREAKERS).breaker).toBe('signups_24h');
  });

  it('gives the manual lock no retry time, because only a human clears it', () => {
    expect(evaluateGate('penny', facts({ manualLock: true }), BREAKERS).retryAfterSeconds).toBeNull();
  });

  it('gives a measured breaker a poll interval, capped at an hour', () => {
    const hourly = evaluateGate('penny', facts({ anthropicMicrocents1h: dollars(99) }), BREAKERS);
    expect(hourly.retryAfterSeconds).toBe(900);
    const daily = evaluateGate('penny', facts({ anthropicMicrocents24h: dollars(99) }), BREAKERS);
    expect(daily.retryAfterSeconds).toBe(3600);
  });

  it('reports the FIRST open breaker in declaration order, so the message is stable', () => {
    const f = facts({ anthropicMicrocents24h: dollars(99), anthropicMicrocents1h: dollars(99) });
    expect(evaluateGate('penny', f, BREAKERS).breaker).toBe('anthropic_spend_24h');
  });
});

describe('retryAfterFor', () => {
  it('is a quarter of the window', () => {
    expect(retryAfterFor(1)).toBe(900);
  });

  it('is never less than a minute or more than an hour', () => {
    expect(retryAfterFor(0)).toBe(60);
    expect(retryAfterFor(24 * 30)).toBe(3600);
  });
});

describe('worstLevel', () => {
  const spec = (id: string, alertAt: number, stopAt: number | null): BreakerSpec => ({
    id: id as BreakerSpec['id'],
    gate: 'penny',
    unit: 'count',
    windowHours: 1,
    alertAt,
    stopAt,
    label: id,
  });

  it('is ok, alert, then open — the banner colour', () => {
    expect(worstLevel([])).toBe('ok');
    expect(worstLevel(evaluateBreakers(CLOSED, [spec('gated_messages_1h', 10, 20)]))).toBe('ok');
    expect(
      worstLevel(
        evaluateBreakers(facts({ gatedMessages1h: 10 }), [spec('gated_messages_1h', 10, 20)])
      )
    ).toBe('alert');
    expect(
      worstLevel(
        evaluateBreakers(facts({ gatedMessages1h: 20 }), [spec('gated_messages_1h', 10, 20)])
      )
    ).toBe('open');
  });
});
