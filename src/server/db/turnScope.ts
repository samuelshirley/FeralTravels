import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The database handle every repo writes through — scoped to the open turn
 * transaction when there is one.
 *
 * WHY (2026-11-11, follow-up to trip 65972b73): a Penny turn dispatches a
 * batch of actions through ~30 repo functions in a dozen modules. An action
 * that passed every pre-dispatch gate and then THREW left every action ahead
 * of it written — half an edit under Penny's "Done". The fix is one
 * transaction per turn, and the question is how the transaction reaches every
 * write.
 *
 * Threading a `tx` argument through each repo function was rejected: dozens of
 * signatures, most with other callers, and the next helper that forgets to
 * pass it on writes outside the transaction with nothing to say so. Instead
 * the exported `db` (client.ts, and the PGlite harness the same way) is a
 * proxy that resolves, per call, to the transaction open in the CURRENT async
 * context, else the root client. A repo cannot forget, because it has no
 * other handle — `turnTransactionGuard.test.ts` fails the suite if any module
 * but client.ts constructs a database client.
 *
 * Two things must NOT be inside the transaction, and each has a rule here:
 *   - ACCOUNTING. usage_events records spend and notable events that happened
 *     whether or not the trip changes. Those writes go through
 *     `deferUntilSettled`: queued while a turn transaction is open, written on
 *     the root client once it commits OR rolls back. (Also: PGlite is a single
 *     connection, so a root write inside its transaction would deadlock —
 *     deferring keeps the test semantics identical to production's.)
 *   - PAID / EXTERNAL CALLS. A Directions call inside an open transaction holds
 *     a connection for a network round trip and, on rollback, has spent money
 *     for a turn that saved nothing. `assertNoTurnTransaction` makes them throw
 *     there; dispatch defers leg geometry until after commit.
 */

type Store = {
  tx: object | null;
  settled: boolean;
  deferred: Array<() => Promise<unknown>>;
};

const als = new AsyncLocalStorage<Store>();

function openStore(): Store | null {
  const s = als.getStore();
  return s && !s.settled && s.tx ? s : null;
}

/** Wrap a root drizzle client so every call resolves to the open turn transaction, if any. */
export function scopedDb<T extends object>(root: T): T {
  return new Proxy(root, {
    get(target, prop) {
      const handle = (openStore()?.tx ?? target) as T;
      const value = Reflect.get(handle, prop, handle);
      return typeof value === 'function' ? value.bind(handle) : value;
    },
  });
}

/** True while the current async context is inside an open turn transaction. */
export function inTurnTransaction(): boolean {
  return openStore() != null;
}

/** Throw if called inside an open turn transaction. For paid / external calls. */
export function assertNoTurnTransaction(what: string): void {
  if (inTurnTransaction()) {
    throw new Error(
      `${what} called inside a Penny turn transaction. Paid and external calls run before the ` +
        'transaction opens or after it commits — see src/server/db/turnScope.ts.',
    );
  }
}

/**
 * Run `write` outside any turn transaction: now, if none is open — returning
 * its result (e.g. an inserted row's id) — otherwise queued and run once the
 * transaction settles, commit or rollback, returning null. Errors in a queued
 * write are logged, never thrown into the turn.
 */
export async function deferUntilSettled<T>(write: () => Promise<T>): Promise<T | null> {
  const s = openStore();
  if (s) {
    s.deferred.push(write);
    return null;
  }
  return write();
}

type Transactional = {
  transaction: <R>(fn: (tx: never) => Promise<R>) => Promise<R>;
};

/**
 * Run `fn` inside one database transaction that every `db` call in its async
 * context joins. If `fn` throws, everything it wrote is rolled back and the
 * error is rethrown. Deferred accounting writes run after, either way.
 */
export async function runInTurnTransaction<R>(db: object, fn: () => Promise<R>): Promise<R> {
  if (inTurnTransaction()) throw new Error('Penny turn transactions do not nest.');
  const store: Store = { tx: null, settled: false, deferred: [] };
  try {
    return await (db as Transactional).transaction(async (tx: never) => {
      store.tx = tx as object;
      return als.run(store, fn);
    });
  } finally {
    store.settled = true;
    for (const write of store.deferred.splice(0)) {
      await write().catch((e) => console.error('[turn-transaction] deferred write failed', e));
    }
  }
}
