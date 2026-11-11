import { describe, expect, it, vi } from 'vitest';

/**
 * The runtime half of "nothing reaches TypeSafe without the sheet that names
 * it": `postSystemOne` checks its proof BEFORE a request exists. The compile
 * half (a call without a proof does not typecheck) and the source half (every
 * outbound AI request is behind an assert) are `aiConsentGuard.test.ts`.
 */

vi.mock('server-only', () => ({}));
vi.mock('@/server/repos/users', () => ({ getAiConsent: vi.fn() }));

import { postSystemOne } from './client';
import type { JevConfig } from './config';
import { requireAiConsent, typeSafeConsentFrom, type TypeSafeConsentProof } from '@/server/aiConsent';
import { getAiConsent } from '@/server/repos/users';

const CONFIG: JevConfig = {
  baseUrl: 'https://api.typesafe.ai',
  host: 'api.typesafe.ai',
  apiKey: 'k',
  model: 'jev-1.13.0',
  timeoutMs: 500,
  t1Min: 0.85,
};
const REQUEST = { model: 'jev-1.13.0', state: 'Message:\nhello', questions: {} };

async function proofFor(userId: string, version: number | null): Promise<TypeSafeConsentProof | null> {
  vi.mocked(getAiConsent).mockResolvedValue({ at: new Date(), version });
  return typeSafeConsentFrom(await requireAiConsent(userId));
}

describe('postSystemOne demands a TypeSafe proof for this user', () => {
  it('a forged proof throws before fetch is called', async () => {
    const fetchImpl = vi.fn();
    const forged = Object.freeze({ userId: 'u1' }) as unknown as TypeSafeConsentProof;
    await expect(postSystemOne(CONFIG, REQUEST, forged, 'u1', fetchImpl)).rejects.toThrow(/missing or forged/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("another user's proof throws before fetch is called", async () => {
    const fetchImpl = vi.fn();
    const proof = (await proofFor('u1', 2))!;
    await expect(postSystemOne(CONFIG, REQUEST, proof, 'u2', fetchImpl)).rejects.toThrow(/another user/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('a version-1 account has no proof to give at all', async () => {
    expect(await proofFor('u1', 1)).toBeNull();
    expect(await proofFor('u1', null)).toBeNull();
  });

  it('a genuine version-2 proof sends', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => new Response('{"answers":{}}', { status: 200 }));
    const proof = (await proofFor('u1', 2))!;
    const res = await postSystemOne(CONFIG, REQUEST, proof, 'u1', fetchImpl);
    expect(res.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe('https://api.typesafe.ai/v1/systemone');
  });
});
