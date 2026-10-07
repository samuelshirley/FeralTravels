/**
 * The "Penny lockdown" block on /admin: the global ceilings, the message gate's
 * last 24h, per-IP hits, and the manual lock.
 *
 * Renders from props; the only interactive child is `PennyLockSwitch`, which has
 * its own test. `@/server/payments` is mocked because its real module opens the
 * database client at import; the formatter stand-in mirrors the real one
 * (microcents as dollars to 2 dp, counts as integers).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';

import type { BreakerSnapshot, BreakerStatus } from '@/server/payments';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('@/server/payments', () => ({
  formatBreakerValue: (s: Pick<BreakerStatus, 'unit' | 'value'>): string =>
    s.unit === 'microcents' ? `$${(s.value / 100_000_000).toFixed(2)}` : String(s.value),
}));

import PennyLockdownBlock from './PennyLockdownBlock';

const STATUSES: BreakerStatus[] = [
  {
    id: 'anthropic_spend_24h',
    gate: 'penny',
    unit: 'microcents',
    level: 'alert',
    value: 1_250_000_000, // $12.50
    alertAt: 1_000_000_000,
    stopAt: 2_500_000_000,
    windowHours: 24,
    label: 'Anthropic spend, 24h',
  },
  {
    id: 'gated_messages_1h',
    gate: 'penny',
    unit: 'count',
    level: 'ok',
    value: 3,
    alertAt: 50,
    stopAt: null,
    windowHours: 1,
    label: 'Refused messages, 1h',
  },
  {
    id: 'manual_lock',
    gate: 'penny',
    unit: 'count',
    level: 'ok',
    value: 0,
    alertAt: 1,
    stopAt: 1,
    windowHours: 0,
    label: 'Manual lock',
  },
];

function snapshot(over: Partial<BreakerSnapshot['facts']> = {}, worst: BreakerSnapshot['worst'] = 'alert'): BreakerSnapshot {
  return {
    facts: {
      anthropicMicrocents24h: 1_250_000_000,
      anthropicMicrocents1h: 0,
      signups1h: 0,
      signups24h: 0,
      gatedMessages1h: 3,
      manualLock: false,
      factsUnavailable: false,
      ...over,
    },
    statuses: STATUSES,
    worst,
  };
}

const empty = { ipHits: [], gateMix: [], topGated: [], lockedOut: [] };

describe('PennyLockdownBlock', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('unexpected fetch'))),
    );
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it.each([
    ['ok', 'ALL CLEAR'],
    ['alert', 'OVER ALERT'],
    ['open', 'REFUSING'],
  ] as const)('worst level %s reads %s', (worst, text) => {
    render(<PennyLockdownBlock snapshot={snapshot({}, worst)} {...empty} />);
    expect(screen.getByTestId('admin-breaker-worst').textContent).toBe(text);
  });

  it('one meter per measured breaker, formatted by unit; the manual lock is not a meter', () => {
    render(<PennyLockdownBlock snapshot={snapshot()} {...empty} />);
    expect(screen.getByText('Anthropic spend, 24h')).toBeInTheDocument();
    expect(screen.getByText('$12.50')).toBeInTheDocument();
    expect(screen.getByText('alert $10.00 · stop $25.00')).toBeInTheDocument();
    expect(screen.getByText('rolling 24h')).toBeInTheDocument();

    expect(screen.getByText('Refused messages, 1h')).toBeInTheDocument();
    expect(screen.getByText('alert 50 · stop never')).toBeInTheDocument();
    expect(screen.getByText('rolling 1h · alert only')).toBeInTheDocument();

    expect(screen.queryByText('Manual lock')).toBeNull();
  });

  it('says the gate is refusing everyone when the facts could not be read', () => {
    render(<PennyLockdownBlock snapshot={snapshot({ factsUnavailable: true })} {...empty} />);
    expect(screen.getByText(/These numbers could not be read/)).toBeInTheDocument();
    cleanup();
    render(<PennyLockdownBlock snapshot={snapshot()} {...empty} />);
    expect(screen.queryByText(/These numbers could not be read/)).toBeNull();
  });

  it('quiet day: no gate traffic and no IP hits are said in words', () => {
    render(<PennyLockdownBlock snapshot={snapshot()} {...empty} />);
    expect(screen.getByText('No messages have been through the gate today.')).toBeInTheDocument();
    expect(screen.getByText('Nothing has hit a limit in the last 24 hours.')).toBeInTheDocument();
    expect(screen.queryByText(/Most refused/)).toBeNull();
    expect(screen.queryByText(/Paused right now/)).toBeNull();
  });

  it('busy day: the tier mix, who was refused most, who is paused, and which IPs hit a limit', () => {
    render(
      <PennyLockdownBlock
        snapshot={snapshot()}
        gateMix={[
          { tier: 'T1', decisions: 40 },
          { tier: 'T3', decisions: 4 },
        ]}
        topGated={[
          { email: 'spam@example.com', refused: 4 },
          { email: null, refused: 1 },
        ]}
        lockedOut={[{ email: 'spam@example.com', lockedUntil: new Date('2026-10-07T13:45:00.000Z') }]}
        ipHits={[{ scope: 'otp_send', ip: '203.0.113.9', count: 10, max: 10 }]}
      />,
    );
    expect(screen.getByText('T1: 40 · T3: 4')).toBeInTheDocument();
    expect(screen.getByText('Most refused: spam@example.com (4), unknown (1)')).toBeInTheDocument();
    expect(screen.getByText('Paused right now: spam@example.com until 13:45Z')).toBeInTheDocument();
    expect(screen.getByText('203.0.113.9')).toBeInTheDocument();
    expect(screen.getByText(/otp_send 10\/10/)).toBeInTheDocument();
  });

  it('says whether Penny is closed by hand, and offers the matching switch', () => {
    render(<PennyLockdownBlock snapshot={snapshot({ manualLock: false })} {...empty} />);
    expect(screen.getByText('Penny is open.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close the app to Penny' })).toBeInTheDocument();
    cleanup();
    render(<PennyLockdownBlock snapshot={snapshot({ manualLock: true })} {...empty} />);
    expect(screen.getByText('Penny is closed by hand. Only admins can plan anything.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open Penny back up' })).toBeInTheDocument();
  });
});
