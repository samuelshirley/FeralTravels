import { describe, it, expect, vi } from 'vitest';

// `server-only` (pulled in via ./geo) throws under the jsdom test env.
vi.mock('server-only', () => ({}));

import { findGapCreatingDeletes, type GateLeg } from './contiguityGate';
import type { ValidatedAction } from './tools';
import fixture from './__fixtures__/prod-turn-65972b73.json';

/**
 * The exact batch that corrupted a production trip on 2026-11-10 — read from
 * `penny_turns.result_meta.turnTrace`, not reconstructed. Penny replaced the
 * whole trip: 11 delete_leg, then 11 add_leg with no placement, the overnight
 * split pair (la Llosa → Intermediate point → Cúllar) emitted LAST. Dispatch
 * places those by geography; main's gate appended them, saw a Girona → la
 * Llosa hole, and blocked every delete while the adds went through.
 */
describe('contiguity gate — production replay, trip 65972b73 turn 2', () => {
  it('does not block a full-trip replacement whose split pair is emitted last', () => {
    const blocked = findGapCreatingDeletes(
      fixture.before as GateLeg[],
      fixture.actions as unknown as ValidatedAction[],
    );
    expect([...blocked]).toEqual([]);
  });
});
