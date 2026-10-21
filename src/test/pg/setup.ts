import { beforeAll } from 'vitest';
import { testDb } from './harness';

/**
 * Boot this file's PGlite and replay the schema DDL BEFORE any test runs.
 *
 * `testDb()` is lazy, so a file whose first test touched the database paid the
 * whole boot inside that test's 5 s budget. `schema.test.ts` had no hook and
 * did exactly that: ~3.5 s alone, past 5 s on a loaded CI runner — PR 90 run
 * 39598707286 failed on "has every table and no other" at 5171 ms with no code
 * change. A hook has its own, larger timeout, so the boot is never a test's cost.
 */
beforeAll(async () => {
  await testDb();
}, 60_000);
