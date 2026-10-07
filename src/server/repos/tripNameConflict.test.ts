import { describe, it, expect, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/server/db/client', () => ({ db: {} }));
// guards.ts boots NextAuth at import; trips.ts only needs its error classes.
vi.mock('@/server/auth/guards', () => import('@/server/auth/errors'));

import { rethrowTripNameConflict } from './trips';
import { ConflictError } from '@/server/auth/errors';

/**
 * A write that loses the check-then-insert race on a trip name hits
 * trips_user_name_unique_idx and Postgres answers 23505. That must reach the
 * client as the same 409 the up-front check gives, not a 500 — and no OTHER
 * error may be dressed up as a name clash. The error objects mirror what
 * postgres-js throws (`PostgresError` carries `code` and `constraint_name`).
 */
function pgError(code: string, constraint_name?: string) {
  return Object.assign(new Error('pg'), { code, constraint_name });
}

function thrownBy(fn: () => void): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error('expected a throw');
}

describe('rethrowTripNameConflict', () => {
  it('turns a unique violation on the trip-name index into the 409', () => {
    const e = thrownBy(() =>
      rethrowTripNameConflict(pgError('23505', 'trips_user_name_unique_idx'), ' Baja '),
    );
    expect(e).toBeInstanceOf(ConflictError);
    expect((e as ConflictError).status).toBe(409);
    expect((e as ConflictError).message).toBe(
      'A trip named "Baja" already exists. Pick a different name.',
    );
  });

  it('rethrows a unique violation on any other constraint untouched', () => {
    const original = pgError('23505', 'trips_pkey');
    expect(thrownBy(() => rethrowTripNameConflict(original, 'Baja'))).toBe(original);
  });

  it('rethrows other Postgres errors on that index untouched', () => {
    const original = pgError('23503', 'trips_user_name_unique_idx');
    expect(thrownBy(() => rethrowTripNameConflict(original, 'Baja'))).toBe(original);
  });

  it('rethrows non-Postgres errors and non-errors untouched', () => {
    const plain = new Error('connection reset');
    expect(thrownBy(() => rethrowTripNameConflict(plain, 'Baja'))).toBe(plain);
    expect(thrownBy(() => rethrowTripNameConflict(null, 'Baja'))).toBe(null);
    expect(thrownBy(() => rethrowTripNameConflict('boom', 'Baja'))).toBe('boom');
  });
});
