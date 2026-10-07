import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';

vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({
  headers: async () => new Headers(),
}));

/**
 * The ownership asserts read one row through a select chain; `limit` is the
 * test's input. Auth.js and the payments module are never reached by the
 * functions under test, but importing guards.ts pulls them in, so they are
 * stubbed rather than booted.
 */
const limit = vi.fn();
const chain = {
  from: () => chain,
  innerJoin: () => chain,
  where: () => chain,
  limit,
};
vi.mock('@/server/db/client', () => ({ db: { select: () => chain } }));
vi.mock('./index', () => ({ auth: vi.fn() }));
vi.mock('@/server/payments', () => ({
  getAccountVerdict: vi.fn(),
  maybeAlertThreshold: vi.fn(),
}));
vi.mock('./admin', () => ({ isAdminEmail: vi.fn() }));

import {
  errorResponse,
  NotFoundError,
  ForbiddenError,
  UnauthorizedError,
  assertTripOwnedByUser,
  assertTripReadableByUser,
  assertLegOwnedByUser,
} from './guards';

beforeEach(() => {
  limit.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'debug').mockImplementation(() => {});
});

describe('errorResponse', () => {
  it('turns a ZodError into a 400 naming every failing path, not a 500', async () => {
    const schema = z.object({ name: z.string(), lat: z.number().min(-90) });
    let thrown: unknown;
    try {
      schema.parse({ lat: -200 });
    } catch (err) {
      thrown = err;
    }
    const res = errorResponse(thrown);
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: string;
      errorId: string;
      issues: { path: string; message: string }[];
    };
    expect(body.errorId).toMatch(/^ERR-/);
    expect(body.issues.map((i) => i.path).sort()).toEqual(['lat', 'name']);
    expect(body.error).toBe(body.issues[0].message);
    // A client mistake is a warning, never filed beside real 5xx failures.
    expect(console.error).not.toHaveBeenCalled();
  });

  it('joins a nested path with dots', async () => {
    const schema = z.object({ stops: z.array(z.object({ lat: z.number() })) });
    const res = errorResponse(schema.safeParse({ stops: [{ lat: 'x' }] }).error);
    const body = (await res.json()) as { issues: { path: string }[] };
    expect(body.issues[0].path).toBe('stops.0.lat');
  });

  it('keeps an HttpError status and its details', async () => {
    expect(errorResponse(new UnauthorizedError()).status).toBe(401);
    expect(errorResponse(new ForbiddenError()).status).toBe(403);
    const res = errorResponse(new NotFoundError('Trip not found'));
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe('Trip not found');
  });

  it('is a 500 for anything it does not recognise, and logs it as an error', async () => {
    const res = errorResponse(new Error('boom'));
    expect(res.status).toBe(500);
    expect(console.error).toHaveBeenCalled();
  });

  it('is a 499 for a client disconnect', () => {
    expect(errorResponse(new Error('aborted')).status).toBe(499);
  });
});

describe('ownership asserts', () => {
  it('assertTripOwnedByUser: 404 missing, 403 another user, passes for the owner', async () => {
    limit.mockResolvedValueOnce([]);
    await expect(assertTripOwnedByUser('t', 'me')).rejects.toBeInstanceOf(NotFoundError);
    limit.mockResolvedValueOnce([{ userId: 'them' }]);
    await expect(assertTripOwnedByUser('t', 'me')).rejects.toBeInstanceOf(ForbiddenError);
    limit.mockResolvedValueOnce([{ userId: 'me' }]);
    await expect(assertTripOwnedByUser('t', 'me')).resolves.toBeUndefined();
  });

  it('assertTripReadableByUser: a template is readable by anyone, a private trip only by its owner', async () => {
    limit.mockResolvedValueOnce([{ userId: 'them', isTemplate: true }]);
    await expect(assertTripReadableByUser('t', 'me')).resolves.toBeUndefined();
    limit.mockResolvedValueOnce([{ userId: 'them', isTemplate: false }]);
    await expect(assertTripReadableByUser('t', 'me')).rejects.toBeInstanceOf(ForbiddenError);
    limit.mockResolvedValueOnce([]);
    await expect(assertTripReadableByUser('t', 'me')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('assertLegOwnedByUser returns the leg trip id for the owner', async () => {
    limit.mockResolvedValueOnce([{ tripId: 'trip-1', userId: 'me' }]);
    await expect(assertLegOwnedByUser('l', 'me')).resolves.toBe('trip-1');
    limit.mockResolvedValueOnce([{ tripId: 'trip-1', userId: 'them' }]);
    await expect(assertLegOwnedByUser('l', 'me')).rejects.toBeInstanceOf(ForbiddenError);
  });
});
