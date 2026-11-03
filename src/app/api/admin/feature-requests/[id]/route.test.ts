import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('@/server/db/client', () => ({ db: {} }));
vi.mock('@/server/payments', () => ({ getAccountVerdict: vi.fn(), maybeAlertThreshold: vi.fn() }));

const m = vi.hoisted(() => ({
  auth: vi.fn(),
  isAdminEmail: vi.fn(),
  updateFeatureRequest: vi.fn(),
  deleteFeatureRequest: vi.fn(),
  createFeatureRequest: vi.fn(),
}));
vi.mock('@/server/auth/index', () => ({ auth: m.auth }));
vi.mock('@/server/auth/admin', () => ({ isAdminEmail: m.isAdminEmail }));
vi.mock('@/server/repos/featureRequests', () => ({
  updateFeatureRequest: m.updateFeatureRequest,
  deleteFeatureRequest: m.deleteFeatureRequest,
  createFeatureRequest: m.createFeatureRequest,
}));

import { DELETE, PATCH } from './route';
import { POST } from '../route';
import { bodyOf, jsonRequest } from '@/test/routeHarness';

const REQ = '00000000-0000-4000-8000-0000000000fa';
const at = { params: { id: REQ } };
const patch = (body: unknown) => PATCH(jsonRequest(`/api/admin/feature-requests/${REQ}`, 'PATCH', body), at);

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  m.auth.mockResolvedValue({ user: { id: 'admin-1', email: 'sam@feraltravels.com' } });
  m.isAdminEmail.mockResolvedValue(true);
  m.updateFeatureRequest.mockResolvedValue(true);
  m.deleteFeatureRequest.mockResolvedValue(true);
  m.createFeatureRequest.mockResolvedValue({ id: REQ });
});

describe('admin feature-request routes refuse everyone but the admin', () => {
  it('no session (a bearer token included) is 401 on every write', async () => {
    m.auth.mockResolvedValue(null);
    expect((await patch({ status: 'open' })).status).toBe(401);
    expect((await DELETE(jsonRequest(`/api/admin/feature-requests/${REQ}`, 'DELETE'), at)).status).toBe(401);
    expect((await POST(jsonRequest('/api/admin/feature-requests', 'POST', { title: 'x' }))).status).toBe(401);
    expect(m.updateFeatureRequest).not.toHaveBeenCalled();
    expect(m.deleteFeatureRequest).not.toHaveBeenCalled();
    expect(m.createFeatureRequest).not.toHaveBeenCalled();
  });

  it('a signed-in non-admin is 403', async () => {
    m.isAdminEmail.mockResolvedValue(false);
    expect((await patch({ status: 'open' })).status).toBe(403);
    expect((await POST(jsonRequest('/api/admin/feature-requests', 'POST', { title: 'x' }))).status).toBe(403);
  });
});

describe('PATCH /api/admin/feature-requests/:id', () => {
  it('sets a status', async () => {
    expect((await patch({ status: 'in_progress' })).status).toBe(200);
    expect(m.updateFeatureRequest).toHaveBeenCalledWith(REQ, { status: 'in_progress' });
  });

  it('a cleared reply box is stored as no reply', async () => {
    await patch({ reply: '   ' });
    expect(m.updateFeatureRequest).toHaveBeenCalledWith(REQ, { reply: null });
  });

  it('trims a reply', async () => {
    await patch({ reply: '  Working on it.  ' });
    expect(m.updateFeatureRequest).toHaveBeenCalledWith(REQ, { reply: 'Working on it.' });
  });

  it('refuses a status that does not exist', async () => {
    expect((await patch({ status: 'shipped' })).status).toBe(400);
    expect(m.updateFeatureRequest).not.toHaveBeenCalled();
  });

  it('refuses an unknown key, and a body that changes nothing', async () => {
    expect((await patch({ status: 'open', votes: 99 })).status).toBe(400);
    expect((await patch({})).status).toBe(400);
    expect(m.updateFeatureRequest).not.toHaveBeenCalled();
  });

  it('an unknown id is 404', async () => {
    m.updateFeatureRequest.mockResolvedValue(false);
    const res = await patch({ status: 'open' });
    expect(res.status).toBe(404);
    expect((await bodyOf(res)).error).toBe('not_found');
  });
});

describe('DELETE /api/admin/feature-requests/:id', () => {
  it('deletes', async () => {
    expect((await DELETE(jsonRequest(`/api/admin/feature-requests/${REQ}`, 'DELETE'), at)).status).toBe(200);
    expect(m.deleteFeatureRequest).toHaveBeenCalledWith(REQ);
  });

  it('an unknown id is 404', async () => {
    m.deleteFeatureRequest.mockResolvedValue(false);
    expect((await DELETE(jsonRequest(`/api/admin/feature-requests/${REQ}`, 'DELETE'), at)).status).toBe(404);
  });
});

describe('POST /api/admin/feature-requests', () => {
  it('creates with a trimmed title, and an empty description as none', async () => {
    const res = await POST(jsonRequest('/api/admin/feature-requests', 'POST', { title: '  Weather  ', body: '' }));
    expect(res.status).toBe(200);
    expect(m.createFeatureRequest).toHaveBeenCalledWith({ title: 'Weather', body: null });
  });

  it('refuses an empty title', async () => {
    expect((await POST(jsonRequest('/api/admin/feature-requests', 'POST', { title: '  ' }))).status).toBe(400);
  });
});
