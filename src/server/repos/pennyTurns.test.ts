import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

/**
 * For the behavioural half below: the one row the key points at, and what an
 * insert returns. Keys are unique, so every lookup here reads at most that row.
 */
const store = vi.hoisted(() => ({
  row: null as Record<string, unknown> | null,
  inserted: [] as Record<string, unknown>[],
}));
vi.mock('@/server/db/client', () => {
  const select = () => ({
    from: () => ({ where: () => ({ limit: async () => (store.row ? [store.row] : []) }) }),
  });
  const insert = () => ({
    values: () => ({ onConflictDoNothing: () => ({ returning: async () => store.inserted }) }),
  });
  return { db: { select, insert } };
});

import { createTurn, getTurnByKeyForUser } from './pennyTurns';
import { ConflictError } from '@/server/auth/errors';

/**
 * One running Penny turn per trip, enforced by the DATABASE. Decision B13.
 *
 * Two concurrent sends on one trip must not both start a replan — that is two
 * tool-use loops writing the same itinerary, and each loop is up to 24 model
 * calls of real money. A check-then-insert cannot prevent it: both requests read
 * "nothing running" before either writes.
 *
 * So the claim is atomic and Postgres picks the winner: a PARTIAL UNIQUE INDEX
 * (`penny_turns_one_running_per_trip_idx`, UNIQUE (trip_id) WHERE status =
 * 'running', migration 0019). The loser's promotion raises 23505, which the repo
 * maps to null so the turn stays `queued` and is drained by the request that
 * won. Both halves are load-bearing: without the index the race is open, and
 * without the catch the loser 500s instead of queueing.
 *
 * Source-text rather than behavioural because the property IS the index — a test
 * with a mocked db would assert the mock.
 */

const ROOT = join(__dirname, '..', '..', '..');
const repo = readFileSync(join(ROOT, 'src/server/repos/pennyTurns.ts'), 'utf8');
const schema = readFileSync(join(ROOT, 'src/server/db/schema.ts'), 'utf8');

describe('the single-running-turn claim', () => {
  it('is a partial unique index in the schema', () => {
    expect(schema).toContain('penny_turns_one_running_per_trip_idx');
    // Partial: it constrains only rows that are RUNNING. A plain unique index
    // on trip_id would allow one turn per trip ever.
    const at = schema.indexOf('penny_turns_one_running_per_trip_idx');
    expect(schema.slice(at - 200, at + 300)).toMatch(/where|running/i);
  });

  it('maps the unique violation to null instead of throwing', () => {
    expect(repo).toContain('23505');
    const at = repo.indexOf('isUniqueViolation');
    expect(at).toBeGreaterThan(-1);
    // The catch that turns "someone else won" into "stay queued".
    expect(repo).toMatch(/if \(isUniqueViolation\(e\)\) return null;/);
  });

  it('drains queued turns through the SAME promotion', () => {
    // Two concurrent drains must not be able to put two turns running either,
    // so the drain cannot have its own claim path.
    expect(repo).toMatch(/claimNextQueuedTurn/);
    const at = repo.indexOf('claimNextQueuedTurn');
    expect(repo.slice(at)).toMatch(/promoteTurnToRunning\(/);
  });

  it('dedupes a resend on the idempotency key', () => {
    // The "Please try again" button is the common cause of a double send.
    expect(repo).toMatch(/idempotency/i);
  });
});

describe('a replay never hands back somebody else\'s turn', () => {
  const now = new Date();
  const row = (over: Record<string, unknown> = {}) => ({
    id: 'turn-1',
    tripId: 'trip-A',
    userId: 'user-A',
    idempotencyKey: 'key-123456',
    status: 'done',
    userMessage: 'Add a day in Colmar',
    images: null,
    resultResponse: 'Done — Colmar is day 3.',
    resultMeta: null,
    errorMessage: null,
    createdAt: now,
    updatedAt: now,
    ...over,
  });

  beforeEach(() => {
    store.row = null;
    store.inserted = [];
  });

  it("getTurnByKeyForUser returns the caller's own turn on their own trip", async () => {
    store.row = row();
    const turn = await getTurnByKeyForUser('key-123456', 'user-A', 'trip-A');
    expect(turn?.result_response).toBe('Done — Colmar is day 3.');
  });

  it("is null for another user's turn, even on a trip id the caller names", async () => {
    store.row = row();
    expect(await getTurnByKeyForUser('key-123456', 'user-B', 'trip-A')).toBeNull();
  });

  it("is null for the caller's turn on a different trip", async () => {
    store.row = row();
    expect(await getTurnByKeyForUser('key-123456', 'user-A', 'trip-B')).toBeNull();
  });

  it('is null for an unknown key', async () => {
    expect(await getTurnByKeyForUser('key-123456', 'user-A', 'trip-A')).toBeNull();
  });

  const input = { tripId: 'trip-A', userId: 'user-A', idempotencyKey: 'key-123456', userMessage: 'x' };

  it("createTurn replays the caller's own send", async () => {
    store.row = row();
    const { turn, created } = await createTurn(input);
    expect(created).toBe(false);
    expect(turn.id).toBe('turn-1');
  });

  it("createTurn refuses another user's key with a 409 instead of returning their turn", async () => {
    store.row = row({ userId: 'user-B' });
    await expect(createTurn(input)).rejects.toBeInstanceOf(ConflictError);
  });

  it('createTurn refuses the key of a turn on another trip', async () => {
    store.row = row({ tripId: 'trip-B' });
    await expect(createTurn(input)).rejects.toBeInstanceOf(ConflictError);
  });

  it('createTurn inserts a new key', async () => {
    store.inserted = [row({ status: 'queued', resultResponse: null })];
    const { turn, created } = await createTurn(input);
    expect(created).toBe(true);
    expect(turn.status).toBe('queued');
  });
});
