/**
 * The resend ladder for sign-in codes — pure arithmetic, no database, no
 * `server-only`. Split out from otp.ts so the rungs can be tested directly:
 * importing otp.ts drags in the db client, Resend and next/headers, and a
 * rate limit nobody can unit-test is a rate limit that drifts.
 */

/**
 * Escalating resend cooldown, indexed by how many codes an address has
 * already been sent inside the current window. The gap required BEFORE send
 * N+1 is `OTP_RESEND_LADDER_MS[N]`, and the last entry is the ceiling that
 * applies from there on.
 *
 *   send 1, 2, 3 →  1s gap   the "it didn't arrive" case, which is real. A
 *                            flat 60s punished the honest user hardest,
 *                            because they are the only one who ever waits.
 *   send 4       → 60s gap   three codes in a row did not fix it, and a
 *                            fourth in the same five seconds will not either.
 *   send 5+      →  2m gap   the ceiling. Deliberately NOT a permanent block:
 *                            a hard block on an address anyone can type IS an
 *                            attack — it locks a stranger out of their own
 *                            sign-in. This throttles forever, it never
 *                            refuses forever.
 *
 * Why a ladder exists at all: the login form and /api/mobile/otp/send are
 * both unauthenticated and both put real email in a real stranger's inbox on
 * demand. The gap is the only thing standing between that and an open relay,
 * and the only thing keeping a Resend quota and sending reputation intact.
 */
export const OTP_RESEND_LADDER_MS = [1_000, 1_000, 1_000, 60_000, 120_000];

/**
 * Idle time after which the ladder resets to the bottom rung. Long enough
 * that a burst cannot be laundered by waiting a few seconds, short enough
 * that someone signing in twice in a day starts fresh the second time.
 */
export const OTP_THROTTLE_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

/** The gap required before the next send, given `sends` already made. */
export function cooldownForSendCount(sends: number): number {
  if (sends <= 0) return 0;
  return OTP_RESEND_LADDER_MS[Math.min(sends, OTP_RESEND_LADDER_MS.length - 1)];
}

/**
 * Seconds remaining, rounded up. Never returns 0 while any wait is left —
 * a countdown that renders "0s" next to a button that still refuses is the
 * exact confusion this whole change is about.
 */
export function retryAfterSeconds(retryAfterMs: number): number {
  return Math.max(1, Math.ceil(retryAfterMs / 1000));
}
