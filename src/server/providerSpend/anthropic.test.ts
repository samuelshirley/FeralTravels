import { describe, expect, it, vi } from 'vitest';
import { fetchAnthropicCost, getAnthropicSpend } from './anthropic';
import type { FetchLike } from './types';

/**
 * The Anthropic spend read, against a fake cost_report. What matters:
 * cents → dollars, the exact UTC-day windows the tiles are labelled with, the
 * projection built from complete days only, and that every failure is an
 * `error` or `not_configured` state — never a number from somewhere else.
 */

// 2026-11-02 15:30 UTC: today is Nov 2, the seven full days are Oct 26 – Nov 1.
const NOW = new Date('2026-11-02T15:30:00Z');

function bucket(day: string, cents: string[], description = 'Claude Haiku 4.5 Usage - Input Tokens') {
  const next = new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  return {
    starting_at: `${day}T00:00:00Z`,
    ending_at: `${next}T00:00:00Z`,
    results: cents.map((amount) => ({ amount, currency: 'USD', description })),
  };
}

const FULL_DAYS = ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01'];

function okFetch(buckets: unknown[], pages?: unknown[][]): { fetchImpl: FetchLike; calls: string[] } {
  const calls: string[] = [];
  let i = 0;
  const fetchImpl: FetchLike = async (url) => {
    calls.push(url);
    const data = pages ? pages[i] : buckets;
    const hasMore = pages ? i < pages.length - 1 : false;
    i++;
    return new Response(JSON.stringify({ data, has_more: hasMore, next_page: hasMore ? `p${i}` : null }), {
      status: 200,
    });
  };
  return { fetchImpl, calls };
}

// $1.00 per full day, plus 50 cents on Oct 26 in a second line; $2.34 today.
const STANDARD = [
  bucket('2026-10-26', ['100', '50'], 'Claude Sonnet Output'),
  ...FULL_DAYS.slice(1).map((d) => bucket(d, ['100'])),
  bucket('2026-11-02', ['234']),
];

describe('fetchAnthropicCost', () => {
  it('asks for day buckets from 7 UTC days ago to tomorrow, grouped by description', async () => {
    const { fetchImpl, calls } = okFetch(STANDARD);
    await fetchAnthropicCost({ adminKey: 'k', now: NOW, fetchImpl });
    const url = new URL(calls[0]);
    expect(url.pathname).toBe('/v1/organizations/cost_report');
    expect(url.searchParams.get('starting_at')).toBe('2026-10-26T00:00:00Z');
    expect(url.searchParams.get('ending_at')).toBe('2026-11-03T00:00:00Z');
    expect(url.searchParams.get('bucket_width')).toBe('1d');
    expect(url.searchParams.getAll('group_by[]')).toEqual(['description']);
  });

  it('sends the admin key and a revalidate hint, and the URL is stable within a day', async () => {
    const seen: RequestInit[] = [];
    const urls: string[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      urls.push(url);
      seen.push(init ?? {});
      return new Response(JSON.stringify({ data: STANDARD, has_more: false, next_page: null }));
    };
    await fetchAnthropicCost({ adminKey: 'sk-ant-admin01-x', now: NOW, fetchImpl });
    await fetchAnthropicCost({ adminKey: 'sk-ant-admin01-x', now: new Date('2026-11-02T23:59:00Z'), fetchImpl });
    expect((seen[0].headers as Record<string, string>)['x-api-key']).toBe('sk-ant-admin01-x');
    expect(seen[0].next).toEqual({ revalidate: 300 });
    expect(urls[0]).toBe(urls[1]);
  });

  it('turns cents into dollars and splits today / yesterday / 7 days / projection', async () => {
    const { fetchImpl } = okFetch(STANDARD);
    const d = await fetchAnthropicCost({ adminKey: 'k', now: NOW, fetchImpl });
    expect(d.todayUsd).toBeCloseTo(2.34);
    expect(d.yesterdayUsd).toBeCloseTo(1);
    // Today + Oct 27..Nov 1 (six days) — Oct 26's $1.50 is outside "7 days".
    expect(d.last7DaysUsd).toBeCloseTo(2.34 + 6);
    // The projection base is the seven COMPLETE days, never today's partial.
    expect(d.fullDays7Usd).toBeCloseTo(7.5);
    expect(d.projectedMonthUsd).toBeCloseTo((7.5 * 30) / 7);
    expect(d.days.map((x) => x.date)).toEqual([...FULL_DAYS, '2026-11-02']);
    expect(d.byLine[0].description).toBe('Claude Haiku 4.5 Usage - Input Tokens');
    expect(d.byLine[0].usd).toBeCloseTo(8.34);
    expect(d.byLine[1].description).toBe('Claude Sonnet Output');
  });

  it('follows pagination', async () => {
    const { fetchImpl, calls } = okFetch([], [STANDARD.slice(0, 4), STANDARD.slice(4)]);
    const d = await fetchAnthropicCost({ adminKey: 'k', now: NOW, fetchImpl });
    expect(calls).toHaveLength(2);
    expect(new URL(calls[1]).searchParams.get('page')).toBe('p1');
    expect(d.fullDays7Usd).toBeCloseTo(7.5);
  });

  it('treats a missing today bucket as $0 so far, but a missing past day as an error', async () => {
    const noToday = okFetch(STANDARD.slice(0, 7));
    expect((await fetchAnthropicCost({ adminKey: 'k', now: NOW, fetchImpl: noToday.fetchImpl })).todayUsd).toBe(0);
    const gap = okFetch([...STANDARD.slice(0, 3), ...STANDARD.slice(4)]);
    await expect(fetchAnthropicCost({ adminKey: 'k', now: NOW, fetchImpl: gap.fetchImpl })).rejects.toThrow(
      /omitted 1 day\(s\): 2026-10-29/
    );
  });

  it('refuses a non-USD currency or a non-numeric amount rather than guessing', async () => {
    const eur = okFetch([{ ...STANDARD[0], results: [{ amount: '1', currency: 'EUR' }] }]);
    await expect(fetchAnthropicCost({ adminKey: 'k', now: NOW, fetchImpl: eur.fetchImpl })).rejects.toThrow(/EUR/);
    const nan = okFetch([{ ...STANDARD[0], results: [{ amount: 'abc', currency: 'USD' }] }]);
    await expect(fetchAnthropicCost({ adminKey: 'k', now: NOW, fetchImpl: nan.fetchImpl })).rejects.toThrow(/non-numeric/);
  });
});

describe('getAnthropicSpend', () => {
  it('is not_configured, naming the variable, when the admin key is unset or blank', async () => {
    const fetchImpl = vi.fn();
    expect(await getAnthropicSpend({ env: {}, fetchImpl })).toEqual({
      status: 'not_configured',
      missing: ['ANTHROPIC_ADMIN_KEY'],
    });
    expect(await getAnthropicSpend({ env: { ANTHROPIC_ADMIN_KEY: '  ' }, fetchImpl })).toMatchObject({
      status: 'not_configured',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('says a workspace key was refused, in words that say what to do', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchImpl: FetchLike = async () => new Response('{"error":{}}', { status: 401 });
    const r = await getAnthropicSpend({ env: { ANTHROPIC_ADMIN_KEY: 'k' }, now: NOW, fetchImpl });
    expect(r.status).toBe('error');
    expect(r.status === 'error' && r.message).toMatch(/HTTP 401.*organization-scoped/);
  });

  it('surfaces a 5xx, a network failure and a changed shape as errors', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const env = { ANTHROPIC_ADMIN_KEY: 'k' };
    const r500 = await getAnthropicSpend({ env, now: NOW, fetchImpl: async () => new Response('boom', { status: 503 }) });
    expect(r500).toEqual({ status: 'error', message: 'Anthropic cost_report HTTP 503: boom' });
    const net = await getAnthropicSpend({
      env,
      now: NOW,
      fetchImpl: async () => {
        throw new Error('ECONNRESET');
      },
    });
    expect(net).toEqual({ status: 'error', message: 'ECONNRESET' });
    const shape = await getAnthropicSpend({ env, now: NOW, fetchImpl: async () => new Response('{"rows":[]}') });
    expect(shape.status === 'error' && shape.message).toMatch(/changed shape/);
  });

  it('returns ok with the figures when the call succeeds', async () => {
    const r = await getAnthropicSpend({ env: { ANTHROPIC_ADMIN_KEY: 'k' }, now: NOW, fetchImpl: okFetch(STANDARD).fetchImpl });
    expect(r.status).toBe('ok');
    expect(r.status === 'ok' && r.data.todayUsd).toBeCloseTo(2.34);
  });
});
