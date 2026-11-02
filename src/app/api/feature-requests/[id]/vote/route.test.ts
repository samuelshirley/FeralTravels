import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('@/server/db/client', () => ({ db: {} }));
vi.mock('@/server/auth/index', () => ({ auth: vi.fn() }));
vi.mock('@/server/auth/admin', () => ({ isAdminEmail: vi.fn() }));
vi.mock('@/server/payments', () => ({ getAccountVerdict: vi.fn(), maybeAlertThreshold: vi.fn() }));

const m = vi.hoisted(() => ({ requireUserId: vi.fn(), setVote: vi.fn() }));
vi.mock('@/server/auth/guards', async (orig) => ({
  ...(await orig<typeof import('@/server/auth/guards')>()),
  requireUserId: m.requireUserId,
}));
vi.mock('@/server/repos/featureRequests', () => ({ setVote: m.setVote }));

import { DELETE, PUT } from './route';
import { UnauthorizedError } from '@/server/auth/errors';
import { UUID, bodyOf, jsonRequest } from '@/test/routeHarness';

const REQ = '00000000-0000-4000-8000-0000000000fa';
const at = (id: string) => ({ params: { id } });
const put = (id = REQ) => PUT(jsonRequest(`/api/feature-requests/${id}/vote`, 'PUT'), at(id));
const del = (id = REQ) => DELETE(jsonRequest(`/api/feature-requests/${id}/vote`, 'DELETE'), at(id));

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  m.requireUserId.mockResolvedValue(UUID.owner);
});

describe('PUT/DELETE /api/feature-requests/:id/vote', () => {
  it('PUT casts the vote and answers the count', async () => {
    m.setVote.mockResolvedValue({ ok: true, voteCount: 4, votedByMe: true });
    const res = await put();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ voteCount: 4, votedByMe: true });
    expect(m.setVote).toHaveBeenCalledWith(UUID.owner, REQ, true);
  });

  it('DELETE withdraws it', async () => {
    m.setVote.mockResolvedValue({ ok: true, voteCount: 3, votedByMe: false });
    const res = await del();
    expect(res.status).toBe(200);
    expect(m.setVote).toHaveBeenCalledWith(UUID.owner, REQ, false);
  });

  it('a closed request is 409 voting_closed', async () => {
    m.setVote.mockResolvedValue({ ok: false, reason: 'voting_closed' });
    const res = await put();
    expect(res.status).toBe(409);
    expect((await bodyOf(res)).error).toBe('voting_closed');
  });

  it('an unknown request is 404 not_found', async () => {
    m.setVote.mockResolvedValue({ ok: false, reason: 'not_found' });
    const res = await put();
    expect(res.status).toBe(404);
    expect((await bodyOf(res)).error).toBe('not_found');
  });

  it('a malformed id is 404 and never reaches the database', async () => {
    const res = await put('not-a-uuid');
    expect(res.status).toBe(404);
    expect(m.setVote).not.toHaveBeenCalled();
  });

  it('signed out is 401, and nothing is written', async () => {
    m.requireUserId.mockRejectedValue(new UnauthorizedError());
    expect((await put()).status).toBe(401);
    expect((await del()).status).toBe(401);
    expect(m.setVote).not.toHaveBeenCalled();
  });
});
