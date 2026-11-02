import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/server/db/client', async () => (await import('./harness')).clientModule());

import * as schema from '@/server/db/schema';
import {
  getAdminOverview,
  getChatPulse,
  getErrorCounts,
  getRecentChatActivity,
  listAdminTrips,
  listAllUsers,
  listErrors,
  listNewSignups,
} from '@/server/repos/admin';
import { httpStatusClassOf, type HttpStatusClass } from '@/lib/httpStatusClass';
import { resetDb, testDb } from './harness';

/**
 * The admin dashboard's reads, against a real Postgres. These are the numbers
 * the tiles print and the lists they open, so each is checked for the window
 * it claims, for who it leaves out, and — for the error classes — that SQL and
 * the TypeScript classifier agree row for row.
 */

beforeEach(resetDb);

const HOUR = 3_600_000;
const ago = (h: number) => new Date(Date.now() - h * HOUR);

async function user(email: string, createdHoursAgo: number, name = 'U') {
  const { db } = await testDb();
  const [row] = await db.insert(schema.users).values({ email, name, createdAt: ago(createdHoursAgo) }).returning();
  return row;
}

async function trip(userId: string, name: string, updatedHoursAgo: number, isTemplate = false) {
  const { db } = await testDb();
  const [row] = await db
    .insert(schema.trips)
    .values({ userId, name, isTemplate, startDateParsed: '2026-11-10', updatedAt: ago(updatedHoursAgo) })
    .returning();
  return row;
}

async function usage(userId: string | null, opts: { hoursAgo: number; microcents?: number; ok?: boolean; msg?: string; provider?: string }) {
  const { db } = await testDb();
  await db.insert(schema.usageEvents).values({
    userId,
    provider: opts.provider ?? 'anthropic',
    costMicrocents: opts.microcents ?? 0,
    success: opts.ok ?? true,
    errorMessage: opts.msg ?? null,
    createdAt: ago(opts.hoursAgo),
  });
}

describe('listNewSignups', () => {
  it('lists real signups in the window, newest first, with last activity and non-template trip count', async () => {
    const fresh = await user('fresh@example.org', 2);
    const older = await user('older@example.org', 30);
    await user('ancient@example.org', 24 * 9);
    await user('sam+trial-abc@feraltravels.com', 1); // internal — hidden, counted
    await trip(fresh.id, 'Girona loop', 1);
    await trip(fresh.id, 'Template', 1, true);
    await usage(older.id, { hoursAgo: 0.5 });

    const day = await listNewSignups(24);
    expect(day.rows.map((r) => r.email)).toEqual(['fresh@example.org']);
    expect(day.hiddenInternal).toBe(1);
    expect(day.rows[0].tripCount).toBe(1);
    expect(day.rows[0].lastActiveAt).toBeInstanceOf(Date);

    const week = await listNewSignups(24 * 7);
    expect(week.rows.map((r) => r.email)).toEqual(['fresh@example.org', 'older@example.org']);
    const o = week.rows[1];
    expect(o.tripCount).toBe(0);
    expect(Math.abs((o.lastActiveAt as Date).getTime() - ago(0.5).getTime())).toBeLessThan(60_000);
  });

  it('a signup who never came back has a null last-active, not the epoch', async () => {
    await user('ghost@example.org', 3);
    const { rows } = await listNewSignups(24);
    expect(rows[0].lastActiveAt).toBeNull();
  });
});

describe('getAdminOverview — active users', () => {
  it('counts real users by last sign of life in 24 h and 7 d', async () => {
    const a = await user('a@example.org', 24 * 20);
    const b = await user('b@example.org', 24 * 20);
    await user('c@example.org', 24 * 20);
    const internal = await user('sam@feraltravels.com', 24 * 20);
    await usage(a.id, { hoursAgo: 2 });
    await trip(b.id, 'b trip', 24 * 3);
    await usage(internal.id, { hoursAgo: 1 });
    const o = await getAdminOverview();
    expect(o.activeUsers24h).toBe(1);
    expect(o.activeUsers7d).toBe(2);
    expect(o.totalUsers).toBe(3);
  });
});

describe('listAllUsers filters', () => {
  async function seed() {
    const big = await user('big@example.org', 50);
    const small = await user('small@example.org', 40);
    const idle = await user('idle@example.org', 30);
    await usage(big.id, { hoursAgo: 20, microcents: 9_000_000 });
    await usage(small.id, { hoursAgo: 1, microcents: 1_000_000 });
    await usage(small.id, { hoursAgo: 1, ok: false, msg: '529 overloaded' });
    await usage(small.id, { hoursAgo: 2, ok: false, msg: 'HTTP 403' });
    await usage(big.id, { hoursAgo: 3, ok: false, msg: '500 boom' });
    return { big, small, idle };
  }

  it('top spend: only users with spend, largest first, with the spend on the row', async () => {
    await seed();
    const r = await listAllUsers({ sort: 'spend_desc' });
    expect(r.rows.map((u) => u.email)).toEqual(['big@example.org', 'small@example.org']);
    expect(r.total).toBe(2);
    expect(r.rows[0].spendMicrocents).toBe(9_000_000);
  });

  it('most recent use: only users seen at all, most recent first', async () => {
    await seed();
    const r = await listAllUsers({ sort: 'active_desc' });
    expect(r.rows.map((u) => u.email)).toEqual(['small@example.org', 'big@example.org']);
  });

  it('errors: only users with failures, most first, with the count on the row', async () => {
    await seed();
    const r = await listAllUsers({ sort: 'errors_desc' });
    expect(r.rows.map((u) => [u.email, u.errorCount])).toEqual([
      ['small@example.org', 2],
      ['big@example.org', 1],
    ]);
  });

  it('the default listing still includes everyone, and search composes with a filter', async () => {
    await seed();
    expect((await listAllUsers({})).total).toBe(3);
    const r = await listAllUsers({ sort: 'spend_desc', search: 'small' });
    expect(r.rows.map((u) => u.email)).toEqual(['small@example.org']);
  });
});

describe('error status classes — SQL and TypeScript agree', () => {
  const CORPUS: Array<[string, HttpStatusClass]> = [
    ['529 {"type":"error","error":{"type":"overloaded_error"}}', '5xx'],
    ['500 Internal server error', '5xx'],
    ['429 {"type":"error","error":{"type":"rate_limit_error"}}', '4xx'],
    ['400 prompt is too long', '4xx'],
    ['Directions API returned HTTP 406.', '4xx'],
    ['Places API (New) HTTP 403.', '4xx'],
    ['Places search failed: HTTP 502', '5xx'],
    ['upstream status: 503', '5xx'],
    ['request failed, status=404', '4xx'],
    ['T3 by haiku: off-topic', 'none'],
    ['Penny replied "couldn\'t apply that cleanly": 4000 chars', 'none'],
    ['trip has 4500 km of driving', 'none'],
    ['ECONNRESET', 'none'],
    ['HTTP 404 then status 500', '5xx'],
  ];

  it('the TypeScript classifier reads the corpus as labelled', () => {
    for (const [msg, cls] of CORPUS) expect([msg, httpStatusClassOf(msg)]).toEqual([msg, cls]);
  });

  it('the /admin/errors filter returns exactly the rows the classifier assigns to each class', async () => {
    for (const [msg] of CORPUS) await usage(null, { hoursAgo: 1, ok: false, msg });
    await usage(null, { hoursAgo: 1, ok: false }); // NULL message
    for (const cls of ['4xx', '5xx', 'none'] as const) {
      const { rows } = await listErrors({ statusClass: cls, limit: 100 });
      const expected = [...CORPUS.filter(([, c]) => c === cls).map(([m]) => m), ...(cls === 'none' ? [null] : [])];
      expect(rows.map((r) => r.errorMessage).sort()).toEqual(expected.sort());
    }
  });

  it('getErrorCounts uses the same predicates, inside its window', async () => {
    for (const [msg] of CORPUS) await usage(null, { hoursAgo: 1, ok: false, msg });
    await usage(null, { hoursAgo: 48, ok: false, msg: '500 old' });
    await usage(null, { hoursAgo: 1, ok: true, msg: '500 but succeeded' });
    const c = await getErrorCounts(24);
    expect(c).toEqual({
      total: CORPUS.length,
      c4xx: CORPUS.filter(([, k]) => k === '4xx').length,
      c5xx: CORPUS.filter(([, k]) => k === '5xx').length,
    });
  });
});

describe('chat and trips', () => {
  it('getChatPulse counts distinct trips in the window and the newest message overall', async () => {
    const u = await user('chat@example.org', 100);
    const t1 = await trip(u.id, 'One', 1);
    const t2 = await trip(u.id, 'Two', 1);
    const { db } = await testDb();
    await db.insert(schema.chatHistory).values([
      { tripId: t1.id, role: 'user', content: 'hi', createdAt: ago(1) },
      { tripId: t1.id, role: 'assistant', content: 'hello', createdAt: ago(0.5) },
      { tripId: t2.id, role: 'user', content: 'old', createdAt: ago(50) },
    ]);
    const p = await getChatPulse(24);
    expect(p.trips).toBe(1);
    expect(p.messages).toBe(2);
    expect(Math.abs((p.lastAt as Date).getTime() - ago(0.5).getTime())).toBeLessThan(60_000);

    const recent = await getRecentChatActivity(10);
    expect(recent[0]).toMatchObject({ tripName: 'One', userEmail: 'chat@example.org', role: 'assistant' });
  });

  it('listAdminTrips: non-template trips, most recently touched first, with leg counts', async () => {
    const u = await user('trips@example.org', 100);
    const a = await trip(u.id, 'Older', 10);
    await trip(u.id, 'Newer', 1);
    await trip(u.id, 'Tpl', 0, true);
    const { db } = await testDb();
    await db.insert(schema.legs).values([
      { tripId: a.id, sortOrder: 0, title: 'A → B' },
      { tripId: a.id, sortOrder: 1, title: 'B → C' },
    ]);
    const rows = await listAdminTrips();
    expect(rows.map((r) => [r.name, r.legCount, r.userEmail])).toEqual([
      ['Newer', 0, 'trips@example.org'],
      ['Older', 2, 'trips@example.org'],
    ]);
  });
});
