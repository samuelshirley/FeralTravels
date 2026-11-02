import { z } from 'zod';
import type { AnthropicCostData, FetchLike, ProviderSpend } from './types';

/**
 * AI spend as ANTHROPIC reports it — the org Admin API's cost report — never
 * our own list-price sum over `usage_events`.
 *
 * Why not our sum: on 2026-09-09 the Console billed $21.94 for Sep 1–8 while
 * prod `usage_events` held $1.80. CI previews and `next dev` write their rows
 * into databases that are deleted afterwards, so the gap cannot be repaired
 * from our side. `scripts/anthropic-usage-report.ts` is the forensic version
 * of this read; this is the dashboard version.
 *
 * Window choice. `cost_report` only offers `bucket_width=1d` (UTC days;
 * platform.claude.com/docs/en/manage-claude/usage-cost-api, checked
 * 2026-11-02), so a rolling 24 h cannot be had from it. The newer Usage and
 * Cost Analytics API offers hourly cost buckets, but its data "typically
 * refreshes within 4 hours … and can take up to 24 hours", so its "last 24 h"
 * would silently miss the most recent hours. The day buckets here appear
 * "within 5 minutes", so the honest labels are "today (UTC, so far)" and "the
 * last 7 UTC days" — and the tiles say exactly that.
 *
 * One request covers everything: the seven complete days before today (the
 * projection's base) plus today. With `group_by[]=description` the same call
 * yields the model × token-type lines for the cost page.
 */

export const ANTHROPIC_COST_URL = 'https://platform.claude.com/cost' as const;
export const ANTHROPIC_ADMIN_KEY_ENV = 'ANTHROPIC_ADMIN_KEY';

const API = 'https://api.anthropic.com';
const VERSION = '2023-06-01';
/** Seconds. The Admin API allows a poll a minute; the dashboard needs far less. */
export const ANTHROPIC_SPEND_REVALIDATE_S = 300;
const DAY_MS = 86_400_000;
/** Full days before today that the projection averages over. */
const FULL_DAYS = 7;

const costResult = z
  .object({
    // A decimal string in CENTS — documented ("lowest units (cents)") and
    // measured on 2026-09-09: the sum read 2194.03 against $21.94 in the Console.
    amount: z.string(),
    currency: z.string(),
    description: z.string().nullable().optional(),
  })
  .passthrough();

const costPage = z.object({
  data: z.array(
    z.object({
      starting_at: z.string(),
      ending_at: z.string(),
      results: z.array(costResult),
    })
  ),
  has_more: z.boolean(),
  next_page: z.string().nullable().optional(),
});

function utcDayStart(now: Date): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Cents (decimal string) → dollars, refusing anything that is not a number. */
function centsToUsd(amount: string): number {
  const n = Number(amount);
  if (!Number.isFinite(n)) throw new Error(`cost_report returned a non-numeric amount: "${amount}"`);
  return n / 100;
}

/**
 * The fetch itself, with every dependency injected so it is testable without
 * a network. Throws on any failure; `getAnthropicSpend` turns that into the
 * `error` state. Throwing (rather than returning) also matters for caching:
 * Next's data cache stores only HTTP 200 responses, so a failure is retried on
 * the next render instead of being served for five minutes.
 */
export async function fetchAnthropicCost(opts: {
  adminKey: string;
  now: Date;
  fetchImpl: FetchLike;
}): Promise<AnthropicCostData> {
  const today = utcDayStart(opts.now);
  const start = today - FULL_DAYS * DAY_MS;
  const end = today + DAY_MS;

  const base = new URLSearchParams({
    // Day-aligned bounds keep the URL — and so the cache key — stable all day.
    starting_at: new Date(start).toISOString().replace('.000Z', 'Z'),
    ending_at: new Date(end).toISOString().replace('.000Z', 'Z'),
    bucket_width: '1d',
    limit: '31',
  });
  base.append('group_by[]', 'description');

  const buckets: z.infer<typeof costPage>['data'] = [];
  let page: string | null = null;
  for (let guard = 0; guard < 10; guard++) {
    const params = new URLSearchParams(base);
    if (page) params.set('page', page);
    const path = '/v1/organizations/cost_report';
    const res = await opts.fetchImpl(`${API}${path}?${params.toString()}`, {
      headers: {
        'x-api-key': opts.adminKey,
        'anthropic-version': VERSION,
        'User-Agent': 'FeralTravelsAdmin/1.0 (https://feraltravels.com)',
      },
      signal: AbortSignal.timeout(10_000),
      next: { revalidate: ANTHROPIC_SPEND_REVALIDATE_S },
    });
    const text = await res.text();
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `Anthropic refused ${ANTHROPIC_ADMIN_KEY_ENV} (HTTP ${res.status}). It must be an ` +
          `organization-scoped admin key, not a workspace key.`
      );
    }
    if (!res.ok) {
      throw new Error(`Anthropic cost_report HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`Anthropic cost_report returned non-JSON: ${text.slice(0, 120)}`);
    }
    const parsed = costPage.safeParse(json);
    if (!parsed.success) {
      throw new Error(`Anthropic cost_report changed shape: ${parsed.error.issues[0]?.message ?? 'unknown'}`);
    }
    buckets.push(...parsed.data.data);
    if (!parsed.data.has_more || !parsed.data.next_page) {
      page = null;
      break;
    }
    page = parsed.data.next_page;
  }
  if (page) throw new Error('Anthropic cost_report kept paging past 10 pages');

  const byDay = new Map<string, number>();
  const byLine = new Map<string, number>();
  for (const b of buckets) {
    const day = b.starting_at.slice(0, 10);
    let dayUsd = byDay.get(day) ?? 0;
    for (const r of b.results) {
      if (r.currency !== 'USD') {
        throw new Error(`Anthropic cost_report returned currency ${r.currency}; this tile only knows USD`);
      }
      const usd = centsToUsd(r.amount);
      dayUsd += usd;
      const line = r.description ?? '(no description)';
      byLine.set(line, (byLine.get(line) ?? 0) + usd);
    }
    byDay.set(day, dayUsd);
  }

  // Every complete day must be present: a missing past bucket would read as $0
  // and drag the projection down. Today's bucket may not exist yet.
  const fullDayKeys = Array.from({ length: FULL_DAYS }, (_, i) => isoDay(start + i * DAY_MS));
  const missing = fullDayKeys.filter((d) => !byDay.has(d));
  if (missing.length > 0) {
    throw new Error(`Anthropic cost_report omitted ${missing.length} day(s): ${missing.join(', ')}`);
  }
  const todayKey = isoDay(today);
  const todayUsd = byDay.get(todayKey) ?? 0;
  const fullDays7Usd = fullDayKeys.reduce((s, d) => s + (byDay.get(d) ?? 0), 0);
  const last6 = fullDayKeys.slice(1).reduce((s, d) => s + (byDay.get(d) ?? 0), 0);

  return {
    todayUsd,
    yesterdayUsd: byDay.get(fullDayKeys[FULL_DAYS - 1]) ?? 0,
    last7DaysUsd: todayUsd + last6,
    fullDays7Usd,
    projectedMonthUsd: (fullDays7Usd * 30) / FULL_DAYS,
    days: [...fullDayKeys, todayKey].map((date) => ({ date, usd: byDay.get(date) ?? 0 })),
    byLine: [...byLine.entries()]
      .map(([description, usd]) => ({ description, usd }))
      .sort((a, b) => b.usd - a.usd),
  };
}

/**
 * The dashboard read: env → fetch → one of the three states. Never throws,
 * never falls back to an estimate.
 */
export async function getAnthropicSpend(
  deps: { env?: Record<string, string | undefined>; now?: Date; fetchImpl?: FetchLike } = {}
): Promise<ProviderSpend<AnthropicCostData>> {
  const env = deps.env ?? process.env;
  const adminKey = env[ANTHROPIC_ADMIN_KEY_ENV]?.trim();
  if (!adminKey) return { status: 'not_configured', missing: [ANTHROPIC_ADMIN_KEY_ENV] };
  const now = deps.now ?? new Date();
  try {
    const data = await fetchAnthropicCost({ adminKey, now, fetchImpl: deps.fetchImpl ?? fetch });
    return { status: 'ok', data };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[providerSpend] Anthropic cost_report failed:', message);
    return { status: 'error', message };
  }
}
