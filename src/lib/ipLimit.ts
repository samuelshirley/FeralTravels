/**
 * Per-IP request limits — the layer between the global circuit breakers and the
 * per-account caps.
 *
 * The breakers bound the bill and the per-account caps bound one user; neither
 * touches the shape of the attack that produces both, which is one machine
 * creating accounts as fast as it can. This is the cheapest thing that makes
 * that expensive.
 *
 * ── What it is NOT ──
 *
 * It is not an authentication boundary, and reading it as one is the way to get
 * this wrong. An IP is a hint: an attacker with a botnet, a phone on cellular
 * data, or a cloud account has as many as they want, and behind a corporate NAT
 * or a university a hundred honest people share one. So the limits are set
 * where a real person will never reach them and an idle attacker will, and the
 * thing that actually bounds the damage is the global breaker above.
 *
 * ── Fixed windows, deliberately ──
 *
 * `windowStart` buckets time, so the count is per bucket rather than rolling.
 * The known cost is a boundary straddle: ten sends at 10:59 and ten more at
 * 11:00 is twenty in two minutes against a limit of ten an hour. That is
 * accepted, because the alternative — a rolling count over a log — is one row
 * written per request, and a table that grows with the attack is a poor defence
 * against a flood. One row per IP per window cannot be made to grow that way.
 *
 * Pure: the count, the clock and the limits are passed in, so every edge is a
 * unit test. The table lives in `src/server/ipLimit.ts`.
 */

export type IpScope = 'otp_send' | 'signup' | 'replan';

export interface IpLimitSpec {
  scope: IpScope;
  /** Requests allowed per window from one address. */
  max: number;
  windowHours: number;
  /** For the log line and the admin panel. */
  label: string;
}

/**
 * The limits.
 *
 * Each is set at roughly ten times what the most impatient real person does,
 * because the cost of being wrong is asymmetric and not close: a false positive
 * locks a real driver out of their own trip, and a false negative costs an
 * attacker one more IP address.
 *
 *  - `otp_send` 10/hour — a person who cannot find the email tries three or
 *    four times. Ten is generous; the OTP resend ladder already spaces them.
 *  - `signup` 5/day — a household sharing one address might legitimately make
 *    two or three accounts. Five is a day's worth of a family, and 1,000 bot
 *    accounts would need 200 addresses.
 *  - `replan` 30/hour — a driver replanning hard does maybe ten in an hour.
 *    Thirty leaves room for a bad day and still bounds a single machine to
 *    ~$2.55 of Haiku an hour before the hourly spend breaker takes over.
 */
export const IP_LIMITS: readonly IpLimitSpec[] = [
  { scope: 'otp_send', max: 10, windowHours: 1, label: 'Sign-in codes sent' },
  { scope: 'signup', max: 5, windowHours: 24, label: 'Accounts created' },
  { scope: 'replan', max: 30, windowHours: 1, label: 'Penny turns' },
] as const;

export function limitFor(scope: IpScope): IpLimitSpec {
  const found = IP_LIMITS.find((l) => l.scope === scope);
  if (!found) throw new Error(`no IP limit configured for scope ${scope}`);
  return found;
}

/**
 * The bucket this moment belongs to, as epoch millis.
 *
 * Floored to the window so every instance agrees on which bucket a request goes
 * in without coordinating — which is what makes the counter a single upsert
 * rather than a read, a decision and a write.
 */
export function windowStartMs(nowMs: number, windowHours: number): number {
  const windowMs = windowHours * 60 * 60 * 1000;
  return Math.floor(nowMs / windowMs) * windowMs;
}

export interface IpLimitVerdict {
  blocked: boolean;
  /** Seconds until this bucket rolls. A real number here, unlike the breakers'. */
  retryAfterSeconds: number;
  /** How many this address has used in the current window, including this one. */
  count: number;
  max: number;
}

/**
 * Decide, given the count AFTER this request has been added.
 *
 * `count > max`, not `>=`: the counter is incremented by the request being
 * judged, so the tenth send of an hour arrives as count 10 and must be allowed.
 * Getting this backwards costs the user the last request of every window, which
 * is the kind of off-by-one nobody reports because it looks like bad luck.
 */
export function decideIpLimit(input: {
  count: number;
  spec: IpLimitSpec;
  nowMs: number;
}): IpLimitVerdict {
  const { count, spec, nowMs } = input;
  const windowMs = spec.windowHours * 60 * 60 * 1000;
  const endsAt = windowStartMs(nowMs, spec.windowHours) + windowMs;
  return {
    blocked: count > spec.max,
    retryAfterSeconds: Math.max(1, Math.ceil((endsAt - nowMs) / 1000)),
    count,
    max: spec.max,
  };
}

/**
 * The caller's address, from the headers a proxy sets.
 *
 * PRECEDENCE MATTERS. `x-vercel-forwarded-for` is written by Vercel's edge and
 * cannot be set by the client; `x-forwarded-for` can be, and on Vercel it is
 * overwritten, but this app also runs on a laptop and in CI where nothing
 * overwrites anything. So the platform header is preferred and the spoofable
 * one is the last resort — which does not make it safe, only ordered. See the
 * "what it is NOT" note above: a spoofed header buys an attacker the same thing
 * a second IP address does, and the global breaker is what bounds that.
 *
 * `x-forwarded-for` is a comma-separated chain appended to by each hop, so the
 * FIRST entry is the client and the rest are proxies.
 *
 * Returns null when there is no address at all — a direct local request, or a
 * server action invoked outside a request scope. A null address is NOT counted
 * and NOT blocked: bucketing every anonymous caller together would make one
 * shared "unknown" counter that locks out everybody the moment it fills.
 */
export function clientIpFromHeaders(get: (name: string) => string | null): string | null {
  const vercel = firstHop(get('x-vercel-forwarded-for'));
  if (vercel) return vercel;
  const real = firstHop(get('x-real-ip'));
  if (real) return real;
  return firstHop(get('x-forwarded-for'));
}

function firstHop(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const first = raw.split(',')[0]?.trim() ?? '';
  if (!first) return null;
  // Guard the column, not the semantics: an address is at most 45 characters
  // (an IPv6 with an embedded IPv4), and anything longer is a header somebody
  // is playing with rather than an address.
  if (first.length > 45) return null;
  return first;
}
