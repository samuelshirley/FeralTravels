import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const logUsageEvent = vi.fn();
const countUsageEventsSince = vi.fn();
vi.mock('@/server/repos/usage', () => ({
  logUsageEvent: (...a: unknown[]) => logUsageEvent(...a),
  countUsageEventsSince: (...a: unknown[]) => countUsageEventsSince(...a),
}));
vi.mock('@/server/auth/admin', () => ({ adminAlertRecipients: () => ['sam@feraltravels.com'] }));
const send = vi.fn();
vi.mock('resend', () => ({
  Resend: class {
    emails = { send };
  },
}));

import { describeFallback, likelyCause, reportPennyFallback, PENNY_FALLBACK_PROVIDER } from './pennyFallbackAlert';
import type { PennyFallback } from '@/lib/penny/fallback';

const LEAK: PennyFallback = { leakedMarkup: true, leakRetries: 1, rawChars: 412, chunks: 1, stopReason: 'end_turn' };
const EMPTY: PennyFallback = { leakedMarkup: false, leakRetries: 0, rawChars: 0, chunks: 0, stopReason: 'end_turn' };
const OTHER: PennyFallback = { leakedMarkup: false, leakRetries: 0, rawChars: 3, chunks: 1, stopReason: 'end_turn' };

const env = { ...process.env };
beforeEach(() => {
  vi.clearAllMocks();
  logUsageEvent.mockResolvedValue(undefined);
  countUsageEventsSince.mockResolvedValue(1);
  send.mockResolvedValue({ error: null });
  process.env.VERCEL_ENV = 'production';
  process.env.AUTH_RESEND_KEY = 're_test';
  process.env.AUTH_EMAIL_FROM = 'Feral Travels <login@feraltravels.com>';
});
afterEach(() => {
  process.env = { ...env };
});

describe('reportPennyFallback', () => {
  it('always writes a failed penny:fallback row carrying the shape, never Penny\'s text', async () => {
    process.env.VERCEL_ENV = 'preview';
    await reportPennyFallback({ userId: 'u1', tripId: 't1', fallback: LEAK });
    expect(logUsageEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u1',
        tripId: 't1',
        provider: PENNY_FALLBACK_PROVIDER,
        success: false,
        errorMessage: expect.stringContaining('leakedMarkup=true leakRetries=1 rawChars=412'),
      })
    );
  });

  it('emails the admin recipients on production, first in the hour', async () => {
    await reportPennyFallback({ userId: 'u1', tripId: 't1', fallback: LEAK });
    expect(send).toHaveBeenCalledTimes(1);
    const mail = send.mock.calls[0][0];
    expect(mail.to).toEqual(['sam@feraltravels.com']);
    expect(mail.subject).toContain("couldn't apply that cleanly");
    expect(mail.text).toContain('u1');
    expect(mail.text).toContain('t1');
    expect(mail.text).toContain(likelyCause(LEAK));
  });

  it('never emails from a preview or a laptop', async () => {
    for (const v of ['preview', 'development', undefined]) {
      if (v) process.env.VERCEL_ENV = v;
      else delete process.env.VERCEL_ENV;
      await reportPennyFallback({ userId: 'u1', tripId: 't1', fallback: EMPTY });
    }
    expect(send).not.toHaveBeenCalled();
    expect(logUsageEvent).toHaveBeenCalledTimes(3);
  });

  it('sends at most one email an hour', async () => {
    countUsageEventsSince.mockResolvedValue(2);
    await reportPennyFallback({ userId: 'u1', tripId: 't1', fallback: LEAK });
    expect(send).not.toHaveBeenCalled();
    const since: Date = countUsageEventsSince.mock.calls[0][1];
    const now = Date.now();
    expect(now - since.getTime()).toBeGreaterThanOrEqual(60 * 60 * 1000 - 1000);
    expect(now - since.getTime()).toBeLessThanOrEqual(60 * 60 * 1000 + 1000);
  });

  it('does not email without Resend configured, and says so', async () => {
    delete process.env.AUTH_RESEND_KEY;
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await reportPennyFallback({ userId: 'u1', tripId: 't1', fallback: LEAK });
    expect(send).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalled();
  });

  it('never throws: the user already has their reply', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    logUsageEvent.mockRejectedValue(new Error('db down'));
    countUsageEventsSince.mockRejectedValue(new Error('db down'));
    await expect(reportPennyFallback({ userId: 'u1', tripId: 't1', fallback: LEAK })).resolves.toBeUndefined();
    send.mockRejectedValue(new Error('resend down'));
    countUsageEventsSince.mockResolvedValue(1);
    await expect(reportPennyFallback({ userId: 'u1', tripId: 't1', fallback: LEAK })).resolves.toBeUndefined();
    expect(err).toHaveBeenCalled();
  });
});

describe('the email names the likely cause from the shape', () => {
  it('distinguishes leaked markup, an empty reply and a third case', () => {
    expect(likelyCause(LEAK)).toMatch(/leaked markup/i);
    expect(likelyCause(EMPTY)).toMatch(/no text and no tool call/i);
    expect(likelyCause(OTHER)).toMatch(/third case/i);
    expect(describeFallback(EMPTY)).toBe('leakedMarkup=false leakRetries=0 rawChars=0 chunks=0 stop=end_turn');
  });
});
