import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/server/db/client', async () => (await import('./harness')).clientModule());

import { featureRequestVotes } from '@/server/db/schema';
import {
  createFeatureRequest,
  deleteFeatureRequest,
  getFeatureRequestStats,
  listFeatureRequestsForAdmin,
  listFeatureRequestsForUser,
  setVote,
  updateFeatureRequest,
} from '@/server/repos/featureRequests';
import { deleteAccount } from '@/server/deleteAccount';
import { FEATURE_REQUEST_STATUSES } from '@/lib/featureRequests';
import { pgError, rawQuery, resetDb, seedUser, testDb } from './harness';

/**
 * Feature requests and votes, through the real repo against a real Postgres.
 * The one-vote rule and both cascades are schema properties, so they are
 * checked here rather than against a mock that would agree with anything.
 */

beforeEach(resetDb);

async function votesFor(requestId: string) {
  return rawQuery<{ user_id: string }>(
    'select user_id from feature_request_votes where request_id = $1',
    [requestId],
  );
}

describe('voting', () => {
  it('a vote is counted once, however many times it is cast', async () => {
    const user = await seedUser();
    const { id } = await createFeatureRequest({ title: 'Weather along the route' });

    expect(await setVote(user.id, id, true)).toEqual({ ok: true, voteCount: 1, votedByMe: true });
    expect(await setVote(user.id, id, true)).toEqual({ ok: true, voteCount: 1, votedByMe: true });
    expect(await votesFor(id)).toHaveLength(1);
  });

  it('the database itself refuses a second vote row', async () => {
    // The structural rule, without the repo's ON CONFLICT in front of it.
    const user = await seedUser();
    const { id } = await createFeatureRequest({ title: 'Share a trip' });
    const { db } = await testDb();
    await db.insert(featureRequestVotes).values({ userId: user.id, requestId: id });
    const err = await pgError(db.insert(featureRequestVotes).values({ userId: user.id, requestId: id }));
    expect(err.code).toBe('23505');
  });

  it('unvoting is idempotent and only removes this user’s vote', async () => {
    const a = await seedUser();
    const b = await seedUser();
    const { id } = await createFeatureRequest({ title: 'Campground stops' });
    await setVote(a.id, id, true);
    await setVote(b.id, id, true);

    expect(await setVote(a.id, id, false)).toEqual({ ok: true, voteCount: 1, votedByMe: false });
    expect(await setVote(a.id, id, false)).toEqual({ ok: true, voteCount: 1, votedByMe: false });
    expect((await votesFor(id)).map((r) => r.user_id)).toEqual([b.id]);
  });

  it('a user can vote on every request', async () => {
    const user = await seedUser();
    const ids = await Promise.all(
      ['One', 'Two', 'Three', 'Four', 'Five'].map(async (t) => (await createFeatureRequest({ title: t })).id),
    );
    for (const id of ids) expect(await setVote(user.id, id, true)).toMatchObject({ ok: true, votedByMe: true });
    const list = await listFeatureRequestsForUser(user.id);
    expect(list.every((r) => r.votedByMe && r.voteCount === 1)).toBe(true);
  });

  it('an unknown request is not_found, and nothing is written', async () => {
    const user = await seedUser();
    const missing = '00000000-0000-4000-8000-000000000000';
    expect(await setVote(user.id, missing, true)).toEqual({ ok: false, reason: 'not_found' });
    expect(await rawQuery('select * from feature_request_votes')).toEqual([]);
  });

  it('a not_doing request refuses votes AND unvotes, and keeps its count', async () => {
    const a = await seedUser();
    const b = await seedUser();
    const { id } = await createFeatureRequest({ title: 'Book campsites in the app' });
    await setVote(a.id, id, true);
    await updateFeatureRequest(id, { status: 'not_doing', reply: 'Booking stays with the campsite.' });

    expect(await setVote(b.id, id, true)).toEqual({ ok: false, reason: 'voting_closed' });
    expect(await setVote(a.id, id, false)).toEqual({ ok: false, reason: 'voting_closed' });
    expect(await votesFor(id)).toHaveLength(1);
  });
});

describe('the list', () => {
  it('in progress first, then open by votes, then not doing; votedByMe is per user', async () => {
    const [a, b, c] = [await seedUser(), await seedUser(), await seedUser()];
    const few = await createFeatureRequest({ title: 'Few votes' });
    const many = await createFeatureRequest({ title: 'Many votes' });
    const working = await createFeatureRequest({ title: 'Working on it' });
    const closed = await createFeatureRequest({ title: 'Not doing' });

    for (const u of [a, b, c]) await setVote(u.id, many.id, true);
    await setVote(a.id, few.id, true);
    for (const u of [a, b, c]) await setVote(u.id, closed.id, true);
    await updateFeatureRequest(working.id, { status: 'in_progress' });
    await updateFeatureRequest(closed.id, { status: 'not_doing' });

    const forB = await listFeatureRequestsForUser(b.id);
    expect(forB.map((r) => [r.title, r.voteCount, r.votedByMe])).toEqual([
      ['Working on it', 0, false],
      ['Many votes', 3, true],
      ['Few votes', 1, false],
      ['Not doing', 3, true],
    ]);
    expect((await listFeatureRequestsForAdmin()).map((r) => r.title)).toEqual(forB.map((r) => r.title));
  });

  it('carries the reply, and clearing it clears its timestamp', async () => {
    const user = await seedUser();
    const { id } = await createFeatureRequest({ title: 'Fuel prices', body: 'At each stop.' });
    await updateFeatureRequest(id, { reply: 'Working on it.' });
    let [row] = await listFeatureRequestsForUser(user.id);
    expect(row).toMatchObject({ title: 'Fuel prices', body: 'At each stop.', reply: 'Working on it.' });
    expect((await rawQuery<{ reply_updated_at: Date | null }>('select reply_updated_at from feature_requests'))[0].reply_updated_at).not.toBeNull();

    await updateFeatureRequest(id, { reply: null });
    [row] = await listFeatureRequestsForUser(user.id);
    expect(row.reply).toBeNull();
    expect((await rawQuery<{ reply_updated_at: Date | null }>('select reply_updated_at from feature_requests'))[0].reply_updated_at).toBeNull();
  });

  it('the stat card counts statuses, and votes only on requests open to voting', async () => {
    const [a, b] = [await seedUser(), await seedUser()];
    const open1 = await createFeatureRequest({ title: 'o1' });
    await createFeatureRequest({ title: 'o2' });
    const prog = await createFeatureRequest({ title: 'p' });
    const closed = await createFeatureRequest({ title: 'n' });
    await setVote(a.id, open1.id, true);
    await setVote(b.id, open1.id, true);
    await setVote(a.id, prog.id, true);
    await setVote(a.id, closed.id, true);
    await updateFeatureRequest(prog.id, { status: 'in_progress' });
    await updateFeatureRequest(closed.id, { status: 'not_doing' });

    expect(await getFeatureRequestStats()).toEqual({ open: 2, inProgress: 1, notDoing: 1, votes: 3 });
  });

  it('an empty table gives zeros, not nulls', async () => {
    expect(await getFeatureRequestStats()).toEqual({ open: 0, inProgress: 0, notDoing: 0, votes: 0 });
  });
});

describe('cascades', () => {
  it('deleting a request deletes its votes', async () => {
    const user = await seedUser();
    const { id } = await createFeatureRequest({ title: 'Gone soon' });
    await setVote(user.id, id, true);
    expect(await deleteFeatureRequest(id)).toBe(true);
    expect(await rawQuery('select * from feature_request_votes')).toEqual([]);
    expect(await deleteFeatureRequest(id)).toBe(false);
  });

  it('deleting an account deletes its votes and leaves everyone else’s', async () => {
    const leaving = await seedUser();
    const staying = await seedUser();
    const { id } = await createFeatureRequest({ title: 'Weather' });
    await setVote(leaving.id, id, true);
    await setVote(staying.id, id, true);

    await deleteAccount(leaving.id, 'self', {
      revoke: async () => {
        throw new Error('no Apple account: revoke must not be called');
      },
    });

    expect((await votesFor(id)).map((r) => r.user_id)).toEqual([staying.id]);
    expect((await listFeatureRequestsForUser(staying.id))[0].voteCount).toBe(1);
  });
});

describe('the status enum', () => {
  it('the database and the shared module list the same statuses, in the same order', async () => {
    const rows = await rawQuery<{ v: string }>(
      `select unnest(enum_range(null::feature_request_status))::text as v`,
    );
    expect(rows.map((r) => r.v)).toEqual([...FEATURE_REQUEST_STATUSES]);
  });

  it('refuses a status that is not in the enum', async () => {
    const { id } = await createFeatureRequest({ title: 'x' });
    const err = await pgError(
      rawQuery(`update feature_requests set status = 'shipped' where id = $1`, [id]),
    );
    expect(err.code).toBe('22P02');
  });

  it('updating an unknown id reports false', async () => {
    expect(await updateFeatureRequest('00000000-0000-4000-8000-000000000000', { status: 'open' })).toBe(false);
  });
});
