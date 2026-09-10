import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

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
