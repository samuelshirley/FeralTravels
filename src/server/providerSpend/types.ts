/**
 * What a provider-sourced spend read can come back as.
 *
 * Three states, and no fourth. There is deliberately no "estimate" variant:
 * these tiles exist because our own `usage_events` math undercounts the real
 * bill (CI previews and `next dev` write rows into databases that are later
 * deleted; see `scripts/anthropic-usage-report.ts`). A read that fails says it
 * failed. It never quietly turns into our own sum, which is the number these
 * tiles replaced.
 */
export type ProviderSpend<T> =
  | { status: 'ok'; data: T }
  /** Which env vars are missing, by name, so the tile can say exactly that. */
  | { status: 'not_configured'; missing: string[] }
  /** The provider's own error, or ours, verbatim enough to act on. */
  | { status: 'error'; message: string };

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Anthropic's own figures, from `/v1/organizations/cost_report`. */
export interface AnthropicCostData {
  /** The current UTC day so far. cost_report is day-bucketed, so this is the finest honest window. */
  todayUsd: number;
  yesterdayUsd: number;
  /** Today (partial) plus the previous six UTC days. */
  last7DaysUsd: number;
  /** The seven COMPLETE UTC days before today: the base of the projection. */
  fullDays7Usd: number;
  /** `fullDays7Usd × 30 / 7`. Derived from Anthropic's figures only. */
  projectedMonthUsd: number;
  /** One entry per UTC day, oldest first, today last. */
  days: Array<{ date: string; usd: number }>;
  /** Cost lines over the whole window (model × token type), largest first. */
  byLine: Array<{ description: string; usd: number }>;
}

/** Google's own figures, from the Cloud Billing export in BigQuery. */
export interface GoogleBillingData {
  /** `YYYYMM`, the billing account's invoice month (Pacific time). */
  invoiceMonth: string;
  /** ISO 4217 code of the billing account — not assumed to be USD. */
  currency: string;
  grossAmount: number;
  /** Credits are negative in the export (free tier, promotions). */
  creditsAmount: number;
  /** gross + credits: what the invoice line will read. */
  netAmount: number;
  byService: Array<{ service: string; netAmount: number }>;
}
