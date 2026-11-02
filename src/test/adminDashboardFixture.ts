import type { AdminDashboardData } from '@/app/admin/tiles';
import type { AnthropicCostData, GoogleBillingData } from '@/server/providerSpend/types';

/**
 * A complete, healthy /admin dashboard read — every source ok — for the tile
 * tests and guards. Override one field to test one tile's other states.
 */
export const NOW = new Date('2026-11-02T15:30:00Z');

export const ANTHROPIC_OK: AnthropicCostData = {
  todayUsd: 2.34,
  yesterdayUsd: 1.1,
  last7DaysUsd: 8.4,
  fullDays7Usd: 7.7,
  projectedMonthUsd: 33,
  days: [
    { date: '2026-10-26', usd: 1.1 },
    { date: '2026-10-27', usd: 1.1 },
    { date: '2026-10-28', usd: 1.1 },
    { date: '2026-10-29', usd: 1.1 },
    { date: '2026-10-30', usd: 1.1 },
    { date: '2026-10-31', usd: 1.1 },
    { date: '2026-11-01', usd: 1.1 },
    { date: '2026-11-02', usd: 2.34 },
  ],
  byLine: [
    { description: 'Claude Haiku 4.5 Usage - Input Tokens, Cache Read', usd: 6 },
    { description: 'Claude Haiku 4.5 Usage - Output Tokens', usd: 4.04 },
  ],
};

export const GOOGLE_OK: GoogleBillingData = {
  invoiceMonth: '202611',
  currency: 'EUR',
  grossAmount: 52.5,
  creditsAmount: -42.25,
  netAmount: 10.25,
  byService: [
    { service: 'Places API (New)', netAmount: 7.75 },
    { service: 'Directions API', netAmount: 2.5 },
  ],
};

export function dashboardFixture(overrides: Partial<AdminDashboardData> = {}): AdminDashboardData {
  return {
    now: NOW,
    overview: {
      ok: true,
      value: {
        totalUsers: 140,
        internalUsers: 6,
        newUsers24h: 12,
        newUsers7d: 61,
        activeUsers24h: 38,
        activeUsers7d: 97,
        totalTrips: 210,
        totalTemplates: 3,
        totalLegs: 1480,
        totalVehicles: 151,
        totalDeletedUsers: 4,
      },
    },
    topSpender: { ok: true, value: { name: 'Big Spender', email: 'big@example.org', microcents: 812_000_000 } },
    chat: { ok: true, value: { trips: 17, messages: 230, lastAt: new Date(NOW.getTime() - 5 * 60_000) } },
    paywallOn: { ok: true, value: true },
    promo: { ok: true, value: { issued: 9, redeemed: 5, open: 3 } },
    anthropic: { status: 'ok', data: ANTHROPIC_OK },
    google: { status: 'ok', data: GOOGLE_OK },
    errors24h: { ok: true, value: { total: 7, c4xx: 3, c5xx: 2 } },
    anthropicAlert: { ok: true, value: null },
    penny: { ok: true, value: { locked: false, worst: 'ok' } },
    jevMode: { ok: true, value: 'off' },
    announcements: { ok: true, value: { activeCount: 1, totalCount: 4 } },
    testUsers: { production: true, armed: false },
    ...overrides,
  };
}
