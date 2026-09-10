import { describe, expect, it } from 'vitest';

import {
  clientIpFromHeaders,
  decideIpLimit,
  IP_LIMITS,
  limitFor,
  windowStartMs,
} from './ipLimit';

/**
 * The window arithmetic and the header parsing, which are the two halves that
 * can be wrong without anything looking wrong: an off-by-one costs every user
 * the last request of every window, and a header read from the wrong place
 * buckets an attacker under whatever address they choose to send.
 */

const HOUR = 60 * 60 * 1000;

function readerFor(h: Record<string, string>): (name: string) => string | null {
  return (name) => h[name] ?? null;
}

describe('the configured limits', () => {
  it('are 10 sign-in codes an hour, 5 accounts a day, 30 Penny turns an hour', () => {
    expect(limitFor('otp_send')).toMatchObject({ max: 10, windowHours: 1 });
    expect(limitFor('signup')).toMatchObject({ max: 5, windowHours: 24 });
    expect(limitFor('replan')).toMatchObject({ max: 30, windowHours: 1 });
  });

  it('throws for a scope with no limit rather than silently allowing it', () => {
    // The failure being guarded: a new scope added to the type, wired into a
    // route, and quietly unlimited because nobody added the number.
    // @ts-expect-error deliberately off-contract
    expect(() => limitFor('made_up')).toThrow(/no IP limit/);
  });

  it('has exactly one spec per scope', () => {
    const scopes = IP_LIMITS.map((l) => l.scope);
    expect(new Set(scopes).size).toBe(scopes.length);
  });
});

describe('windowStartMs', () => {
  it('floors to the window, so every instance agrees without coordinating', () => {
    expect(windowStartMs(3 * HOUR + 59 * 60 * 1000, 1)).toBe(3 * HOUR);
    expect(windowStartMs(3 * HOUR, 1)).toBe(3 * HOUR);
  });

  it('buckets a 24-hour window on the day', () => {
    expect(windowStartMs(25 * HOUR, 24)).toBe(24 * HOUR);
  });
});

describe('decideIpLimit', () => {
  const spec = limitFor('otp_send');

  it('allows the LAST request of the window, not one fewer', () => {
    // The counter is incremented BY the request being judged, so the tenth send
    // arrives as count 10 and must pass. `>=` here would silently cost every
    // user the last request of every window — the kind of off-by-one nobody
    // reports because it reads as bad luck.
    expect(decideIpLimit({ count: 10, spec, nowMs: 0 }).blocked).toBe(false);
  });

  it('blocks the one after that', () => {
    expect(decideIpLimit({ count: 11, spec, nowMs: 0 }).blocked).toBe(true);
  });

  it('reports a real wait — the time until the bucket rolls', () => {
    const nowMs = 3 * HOUR + 30 * 60 * 1000; // half an hour into the window
    expect(decideIpLimit({ count: 11, spec, nowMs }).retryAfterSeconds).toBe(1800);
  });

  it('never reports a wait of zero, however close the boundary is', () => {
    const nowMs = 4 * HOUR - 1;
    expect(decideIpLimit({ count: 11, spec, nowMs }).retryAfterSeconds).toBeGreaterThan(0);
  });

  it('carries the count and the limit so the log line can say both', () => {
    expect(decideIpLimit({ count: 11, spec, nowMs: 0 })).toMatchObject({ count: 11, max: 10 });
  });
});

describe('clientIpFromHeaders', () => {
  it('prefers the header the platform writes over the one a client can', () => {
    // `x-forwarded-for` is client-settable; `x-vercel-forwarded-for` is written
    // by the edge. Reading them the other way round would let a caller pick
    // their own counter, which is the whole limit undone in one line.
    const ip = clientIpFromHeaders(
      readerFor({
        'x-vercel-forwarded-for': '203.0.113.7',
        'x-real-ip': '198.51.100.1',
        'x-forwarded-for': '10.0.0.1',
      })
    );
    expect(ip).toBe('203.0.113.7');
  });

  it('falls back to x-real-ip, then to x-forwarded-for', () => {
    expect(clientIpFromHeaders(readerFor({ 'x-real-ip': '198.51.100.1' }))).toBe('198.51.100.1');
    expect(clientIpFromHeaders(readerFor({ 'x-forwarded-for': '10.0.0.1' }))).toBe('10.0.0.1');
  });

  it('takes the FIRST hop of a forwarded chain — the client, not the proxy', () => {
    expect(
      clientIpFromHeaders(readerFor({ 'x-forwarded-for': '203.0.113.7, 70.41.3.18, 150.172.238.178' }))
    ).toBe('203.0.113.7');
  });

  it('reads an IPv6 address whole', () => {
    const v6 = '2001:0db8:85a3:0000:0000:8a2e:0370:7334';
    expect(clientIpFromHeaders(readerFor({ 'x-forwarded-for': v6 }))).toBe(v6);
  });

  it('returns null when there is no address at all', () => {
    // Not a bucket. Every anonymous caller sharing one counter would fill it
    // and lock out everybody it could not identify.
    expect(clientIpFromHeaders(readerFor({}))).toBeNull();
    expect(clientIpFromHeaders(readerFor({ 'x-forwarded-for': '' }))).toBeNull();
    expect(clientIpFromHeaders(readerFor({ 'x-forwarded-for': '  ,  ' }))).toBeNull();
  });

  it('refuses a value too long to be an address', () => {
    // 45 characters is the longest legal address (IPv6 with an embedded IPv4).
    // Longer is somebody playing with the header, and it would go straight into
    // a primary key column.
    expect(clientIpFromHeaders(readerFor({ 'x-forwarded-for': 'a'.repeat(46) }))).toBeNull();
    expect(clientIpFromHeaders(readerFor({ 'x-forwarded-for': 'a'.repeat(45) }))).toBe(
      'a'.repeat(45)
    );
  });
});
