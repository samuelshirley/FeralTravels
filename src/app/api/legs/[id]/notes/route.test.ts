import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

/**
 * The route's boundary, with Auth.js and the database stubbed (their real
 * import chain cannot resolve under vitest — see reactivateRoute.test.ts).
 * What is under test: only the owner writes, the payload is exactly
 * `{ notes: string[] }` inside its bounds, and a bad one is a 400 that never
 * reaches the repo.
 */
const requireUserId = vi.fn();
const assertLegOwnedByUser = vi.fn();
const setLegNotes = vi.fn();

vi.mock('@/server/auth/guards', () => ({
  requireUserId: () => requireUserId(),
  assertLegOwnedByUser: (...args: unknown[]) => assertLegOwnedByUser(...args),
  errorResponse: (err: unknown) =>
    new Response(JSON.stringify({ error: String(err) }), {
      status: (err as { status?: number })?.status ?? 500,
    }),
}));
vi.mock('@/server/repos/trips', () => ({
  setLegNotes: (...args: unknown[]) => setLegNotes(...args),
}));

import { PATCH } from './route';

const LEG_ID = '00000000-0000-0000-0000-0000000000c0';

function put(body: unknown, id = LEG_ID) {
  return PATCH(
    new Request(`https://example.test/api/legs/${id}/notes`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: { id } },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  requireUserId.mockResolvedValue('u-owner');
  assertLegOwnedByUser.mockResolvedValue('trip-1');
  setLegNotes.mockImplementation(async (_id: string, notes: string[]) => notes);
});

describe('PATCH /api/legs/:id/notes', () => {
  it('saves the full list, trimmed, and returns it', async () => {
    const res = await put({ notes: ['  Port Wine cellars  ', 'Laundry'] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ notes: ['Port Wine cellars', 'Laundry'] });
    expect(assertLegOwnedByUser).toHaveBeenCalledWith(LEG_ID, 'u-owner');
    expect(setLegNotes).toHaveBeenCalledWith(LEG_ID, ['Port Wine cellars', 'Laundry']);
  });

  it('accepts an empty list — deleting the last note clears the day', async () => {
    const res = await put({ notes: [] });
    expect(res.status).toBe(200);
    expect(setLegNotes).toHaveBeenCalledWith(LEG_ID, []);
  });

  it("refuses someone else's leg with the guard's status and never writes", async () => {
    assertLegOwnedByUser.mockRejectedValue(Object.assign(new Error('Forbidden'), { status: 403 }));
    const res = await put({ notes: ['mine now'] });
    expect(res.status).toBe(403);
    expect(setLegNotes).not.toHaveBeenCalled();
  });

  it('is a 404 for a leg that does not exist', async () => {
    assertLegOwnedByUser.mockRejectedValue(Object.assign(new Error('Leg not found'), { status: 404 }));
    const res = await put({ notes: ['x'] });
    expect(res.status).toBe(404);
    expect(setLegNotes).not.toHaveBeenCalled();
  });

  it('is a 401 when signed out', async () => {
    requireUserId.mockRejectedValue(Object.assign(new Error('Unauthorized'), { status: 401 }));
    const res = await put({ notes: ['x'] });
    expect(res.status).toBe(401);
    expect(setLegNotes).not.toHaveBeenCalled();
  });

  it('rejects a malformed leg id', async () => {
    const res = await put({ notes: ['x'] }, 'not-a-uuid');
    expect(res.status).toBe(400);
    expect(setLegNotes).not.toHaveBeenCalled();
  });

  it.each([
    ['an empty note', { notes: [''] }],
    ['a whitespace-only note', { notes: ['   '] }],
    ['a note over 500 characters', { notes: ['x'.repeat(501)] }],
    ['more than 20 notes', { notes: Array.from({ length: 21 }, (_, i) => `n${i}`) }],
    ['an extra key', { notes: ['x'], legId: LEG_ID }],
    ['a missing notes key', {}],
    ['a string instead of an array', { notes: 'x' }],
    ['a non-string note', { notes: [42] }],
  ])('rejects %s with a 400, not a 500', async (_label, body) => {
    const res = await put(body);
    expect(res.status).toBe(400);
    expect(setLegNotes).not.toHaveBeenCalled();
  });

  it("says why in `error`, since that string is the client's toast", async () => {
    const res = await put({ notes: Array.from({ length: 21 }, (_, i) => `n${i}`) });
    expect((await res.json()).error).toBe('A day holds at most 20 notes');
  });

  it('accepts the bounds themselves: 20 notes of 500 characters', async () => {
    const notes = Array.from({ length: 20 }, () => 'x'.repeat(500));
    const res = await put({ notes });
    expect(res.status).toBe(200);
    expect(setLegNotes).toHaveBeenCalledWith(LEG_ID, notes);
  });
});
