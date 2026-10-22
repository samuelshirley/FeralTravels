import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/server/db/client', async () => (await import('./harness')).clientModule());

import { countUsageEventsSince, logUsageEvent } from '@/server/repos/usage';
import { rawQuery, resetDb } from './harness';

beforeEach(resetDb);

describe('countUsageEventsSince', () => {
  it('counts only that provider, and only rows at or after the cutoff', async () => {
    await logUsageEvent({ provider: 'penny:fallback', requests: 0, success: false });
    await logUsageEvent({ provider: 'penny:fallback', requests: 0, success: false });
    await logUsageEvent({ provider: 'penny:tool-call-leak', requests: 0, success: false });
    // Push one fallback row two hours into the past.
    await rawQuery(
      `update usage_events set created_at = now() - interval '2 hours'
        where ctid = (select ctid from usage_events where provider = 'penny:fallback' limit 1)`
    );
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
    expect(await countUsageEventsSince('penny:fallback', hourAgo)).toBe(1);
    expect(await countUsageEventsSince('penny:fallback', new Date(Date.now() - 3 * 60 * 60 * 1000))).toBe(2);
    expect(await countUsageEventsSince('penny:nothing', hourAgo)).toBe(0);
  });
});
