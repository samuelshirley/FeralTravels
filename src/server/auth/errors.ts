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
