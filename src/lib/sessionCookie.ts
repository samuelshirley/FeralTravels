/**
 * The two names an Auth.js database session cookie can have.
 *
 * Pure and dependency-free ON PURPOSE: `middleware.ts` imports this and runs on
 * the edge, so nothing here may reach for the database, `server-only`, or any
 * Node built-in.
 *
 * These were written out in three places before this file existed — spelled as
 * a literal array in `middleware.ts`, derived from env by the private
 * `getSessionCookieName()` in `server/auth/otp.ts`, and needed a fourth time by
 * `server/auth/sessionStore.ts`. Auth.js picks between them by whether the
 * deployment is on https, so a reader that checks only one is a reader that
 * works in dev and silently sees nothing in production.
 */

/** Plain http (local dev, `next start` over http://localhost). */
export const SESSION_COOKIE_NAME = 'authjs.session-token';

/** https — Auth.js applies the `__Secure-` prefix. */
export const SECURE_SESSION_COOKIE_NAME = '__Secure-authjs.session-token';

/**
 * Both, for any reader that has to find the cookie without knowing which half
 * of the switch wrote it. Order is irrelevant — only one is ever set.
 */
export const SESSION_COOKIE_NAMES = [
  SESSION_COOKIE_NAME,
  SECURE_SESSION_COOKIE_NAME,
] as const;
