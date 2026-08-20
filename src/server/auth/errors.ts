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
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
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
