/**
 * The row shapes `/api/test/turn`'s `gate-ledger` action returns, and the pure
 * mapping from `usage_events` columns to them. Separate from the repo so the
 * one property that matters, NEVER USER TEXT, is unit-tested without a
 * database (`gateLedger.test.ts`).
 */

/** One `provider: 'jev'` row. */
export interface FixtureJevRow {
  success: boolean;
  choice: string | null;
  top: number | null;
  settled: boolean | null;
  deferredReason: string | null;
}

/** One `penny:gate` row: the final decision on one message. */
export interface FixtureGateRow {
  tier: string | null;
  /** `allow_rule` | `deny_rule` | `classifier` | `error`. */
  by: string | null;
  /** The classifier decision was Jev's (reason `jev T1 p=…`), not Haiku's. */
  byJev: boolean;
}

/**
 * A gate row is written as `${tier} by ${by}: ${reason}` (messageGate.ts
 * `record`). Only the tier and the decider leave: when the classifier decided,
 * the reason is Haiku's own words about the message, so it stays in the
 * database.
 */
export function gateRowFromUsage(row: { model: string | null; errorMessage: string | null }): FixtureGateRow {
  const m = /^T[123] by (\w+): (jev )?/.exec(row.errorMessage ?? '');
  return { tier: row.model, by: m ? m[1] : null, byJev: Boolean(m?.[2]) };
}

/** Picked key by key, typed, never spread: `meta` is jsonb and could hold anything. */
export function jevRowFromUsage(row: { success: boolean; meta: unknown }): FixtureJevRow {
  const meta = (row.meta && typeof row.meta === 'object' ? row.meta : {}) as Record<string, unknown>;
  return {
    success: row.success,
    choice: typeof meta.choice === 'string' ? meta.choice : null,
    top: typeof meta.top === 'number' ? meta.top : null,
    settled: typeof meta.settled === 'boolean' ? meta.settled : null,
    deferredReason: typeof meta.deferredReason === 'string' ? meta.deferredReason : null,
  };
}
