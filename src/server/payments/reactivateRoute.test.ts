import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

/**
 * The route's own behaviour, with the two things behind it stubbed.
 *
 * `requireAdmin` and `reactivateSubscription` both reach Auth.js and the
 * database respectively, and next 14 ships no `./server` export map, so the
 * real import chain cannot resolve under vitest at all. What is under test here
 * is the boundary: who is allowed to call it, what a missing reason does, and —
 * the part that matters most — that a refusal from the payments module reaches
 * the caller as a 400 with its sentence rather than as a quiet 200.
 */
const requireAdmin = vi.fn();
const reactivateSubscription = vi.fn();
const errorResponse = vi.fn(
  (err: unknown) =>
    new Response(JSON.stringify({ error: String(err) }), {
      status: (err as { status?: number })?.status ?? 500,
    }),
);

vi.mock('@/server/auth/guards', () => ({
  requireAdmin: (...args: unknown[]) => requireAdmin(...args),
  errorResponse: (err: unknown) => errorResponse(err),
}));
vi.mock('@/server/payments', () => ({
  reactivateSubscription: (...args: unknown[]) => reactivateSubscription(...args),
}));

import { POST } from '@/app/api/admin/subscription/reactivate/route';

function request(body: unknown): Request {
  return new Request('https://example.test/api/admin/subscription/reactivate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const ADMIN = { id: 'u-admin', email: 'admin@example.test' };

beforeEach(() => {
  vi.clearAllMocks();
  requireAdmin.mockResolvedValue(ADMIN);
  reactivateSubscription.mockResolvedValue({ ok: true, action: 'restore', status: 'active' });
});

describe('POST /api/admin/subscription/reactivate', () => {
  it('restores an account and says what it restored it to', async () => {
    const res = await POST(request({ userId: 'u-1', reason: 'revoked by mistake' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, action: 'restore', status: 'active' });
    // The admin's ADDRESS, not their id: the audit is read by a human months
    // later and an opaque uuid answers "who did this?" badly.
    expect(reactivateSubscription).toHaveBeenCalledWith('u-1', ADMIN.email, 'revoked by mistake');
  });

  it('refuses a missing reason with a 400 and a sentence, not a 500', async () => {
    /*
     * The reason is required at the boundary, not merely in the UI: a control
     * that moves paid access has to leave a record that survives whoever
     * pressed it. `errorResponse` would turn the ZodError into a 500 with a
     * Zod dump in it, which tells the admin nothing.
     */
    for (const body of [{ userId: 'u-1' }, { userId: 'u-1', reason: '   ' }]) {
      const res = await POST(request(body));
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((await res.json()).error).toBe('A reason is required');
    }
    expect(reactivateSubscription).not.toHaveBeenCalled();
  });

  it('never reaches the payments module for a non-admin', async () => {
    const forbidden = Object.assign(new Error('Forbidden'), { status: 403 });
    requireAdmin.mockRejectedValue(forbidden);

    const res = await POST(request({ userId: 'u-1', reason: 'because' }));
    expect(res.status).toBe(403);
    expect(reactivateSubscription).not.toHaveBeenCalled();
    // The admin check runs BEFORE the body is even parsed, so a non-admin
    // cannot learn anything about the account they named either.
    expect(errorResponse).toHaveBeenCalledWith(forbidden);
  });

  it('turns every refusal into a 400 carrying its own sentence', async () => {
    /*
     * A refusal that came back 200 would leave an admin believing they had
     * restored somebody who is still locked out — which is the exact failure
     * this whole change exists to remove, reintroduced one layer up.
     */
    const refusals = [
      { reason: 'not_revoked', message: 'This account is not revoked — its plan is “active”.' },
      { reason: 'no_subscription_row', message: 'This account has no plan row at all.' },
      { reason: 'no_pre_revoke_status', message: 'This account was revoked before the undo existed.' },
    ];
    for (const refusal of refusals) {
      reactivateSubscription.mockResolvedValue({ ok: false, ...refusal });
      const res = await POST(request({ userId: 'u-1', reason: 'trying anyway' }));
      expect(res.status, refusal.reason).toBe(400);
      expect(await res.json()).toEqual({ error: refusal.message, reason: refusal.reason });
    }
  });

  it('reports a genuine failure through errorResponse, not as a refusal', async () => {
    // A database that is down is a 500. Flattening it into the 400 branch would
    // tell the admin their account was ineligible when nothing was even read.
    const boom = new Error('connection terminated');
    reactivateSubscription.mockRejectedValue(boom);
    const res = await POST(request({ userId: 'u-1', reason: 'because' }));
    expect(res.status).toBe(500);
    expect(errorResponse).toHaveBeenCalledWith(boom);
  });
});
