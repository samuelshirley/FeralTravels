/**
 * HTTP error classes, split out of guards.ts so modules that only need to
 * THROW one don't have to import the guards — which pull in Auth.js, the
 * Drizzle adapter and a live DB client just to get at a class definition.
 * (That import chain is why `oauthIdentity.ts` lives apart from its route:
 * it stays unit-testable without booting half the server.)
 *
 * guards.ts re-exports all four, so every existing
 * `import { HttpError } from '@/server/auth/guards'` keeps working and
 * `instanceof` still matches — there is exactly one class object per error.
 */

export class HttpError extends Error {
  status: number;
  /**
   * Extra machine-readable fields merged into the JSON body by `errorResponse`.
   *
   * Added for the paywall, and deliberately narrow. Until now the only
   * structured field on any error body was `errorId`, which is a log
   * correlation id — so every client branched on the HTTP status alone and a
   * 402 could not be told apart from any other 402 we might ever add. The
   * message text is not that discriminator: it is copy, and copy changes.
   */
  details?: Record<string, unknown>;
  constructor(status: number, message: string, details?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export class UnauthorizedError extends HttpError {
  constructor(message = 'Unauthorized') {
    super(401, message);
  }
}

export class ForbiddenError extends HttpError {
  constructor(message = 'Forbidden') {
    super(403, message);
  }
}

export class NotFoundError extends HttpError {
  constructor(message = 'Not found') {
    super(404, message);
  }
}

export class ConflictError extends HttpError {
  constructor(message = 'Conflict') {
    super(409, message);
  }
}

/**
 * 402. The account is real and authenticated — it just is not entitled.
 *
 * Distinct from 403 on purpose: Forbidden means "not yours", and a client that
 * conflates the two will show a paywall to someone poking at another user's
 * trip. The body carries `code`, `state` and `blockReason` so the app can pick
 * the right copy without parsing the message.
 */
export class PaymentRequiredError extends HttpError {
  constructor(message: string, details: Record<string, unknown>) {
    super(402, message, details);
  }
}

/**
 * 503. We could not reach the session store — so we do not know whether this
 * person is signed in, and must not answer as though we do.
 *
 * THE BUG THIS EXISTS FOR. Sessions are `strategy: 'database'`, so `auth()`
 * reads the `sessions` row through the Drizzle adapter on every request. When
 * that read THROWS, Auth.js swallows it as `SessionTokenError` and `auth()`
 * returns `null` — byte-for-byte what a signed-out visitor produces. Thirteen
 * pages then do the only thing that shape permits, `redirect('/login')`, and a
 * database blip becomes a site-wide silent sign-out. Observed in production
 * shape on 2026-09-08: a preview's Neon branch was deleted underneath a live
 * session and the logs read `password authentication failed for user
 * 'neondb_owner'` on `/admin`, one second after `/admin` had rendered 200.
 *
 * 503 and not 401, and the difference is not cosmetic: `mobile/lib/api.ts`
 * clears the keychain on 401. A 401 here would permanently sign every iOS user
 * out of their device because a database hiccuped.
 *
 * `digest` is load-bearing. Next redacts a server component's error `message`
 * in production but passes through a `digest` the error already carries, so
 * this literal is the ONLY thing `src/app/error.tsx` can branch on to say
 * "you have not been signed out" rather than something generic.
 */
export const SESSION_STORE_UNAVAILABLE_DIGEST = 'SESSION_STORE_UNAVAILABLE';

export class SessionStoreUnavailableError extends HttpError {
  digest = SESSION_STORE_UNAVAILABLE_DIGEST;
  constructor(message = "We couldn't reach your account. You have not been signed out.") {
    super(503, message);
  }
}

/**
 * 503. A global circuit breaker is open — the app as a whole is over a spend or
 * sign-up ceiling, so this request is refused even though the caller has done
 * nothing wrong.
 *
 * WHY 503 AND NOT 401 OR 402, both of which are wrong in specific ways:
 *
 *  - 401 clears the iOS keychain (`mobile/lib/api.ts`), so using it here would
 *    sign every device out because the app was busy. Same trap
 *    `SessionStoreUnavailableError` documents.
 *  - 402 is the paywall's word. A client that saw one here would offer the user
 *    a subscription that would not help — they are not unentitled, the app is
 *    closed — and the App Store review notes describe 402 as meaning one thing.
 *
 * 503 is the honest code: the service is temporarily unable to handle the
 * request. `details` carries `code: 'circuit_open'`, the breaker's id and a
 * poll interval so a client can say something better than "try again".
 */
export const CIRCUIT_OPEN_CODE = 'circuit_open';

export class CircuitOpenError extends HttpError {
  constructor(
    breaker: string,
    retryAfterSeconds: number | null,
    message = 'Penny is paused right now. Nothing is wrong with your account.'
  ) {
    super(503, message, { code: CIRCUIT_OPEN_CODE, breaker, retryAfterSeconds });
  }
}
