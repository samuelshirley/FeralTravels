import { ANTHROPIC_COST_URL } from '@/server/providerSpend/anthropic';
import { GOOGLE_BILLING_REPORTS_URL } from '@/server/providerSpend/google';
import type { AnthropicCostData, GoogleBillingData, ProviderSpend } from '@/server/providerSpend/types';

/**
 * The /admin homepage, as data: sections of tiles, every one of which opens a
 * screen. Pure — no database, no React — so the whole map can be built from
 * fixtures and checked (`tiles.test.ts`, `adminTilesGuard.test.ts`).
 *
 * NO DEAD ENDS, structurally. `href` is required and typed: an internal tile
 * can only name a route in `ADMIN_ROUTES`, an external one only a URL in
 * `EXTERNAL_LINKS`. A tile without somewhere to go does not compile, and the
 * guard test checks that every `ADMIN_ROUTES` entry is a real `page.tsx`.
 */

export const ADMIN_ROUTES = [
  '/admin/signups',
  '/admin/users',
  '/admin/deleted',
  '/admin/trips',
  '/admin/vehicles',
  '/admin/chats',
  '/admin/cost',
  '/admin/paywall',
  '/admin/promo',
  '/admin/errors',
  '/admin/penny',
  '/admin/classifier',
  '/admin/announcements',
  '/admin/test-users',
] as const;
export type AdminRoute = (typeof ADMIN_ROUTES)[number];

export const EXTERNAL_LINKS = {
  anthropicCost: ANTHROPIC_COST_URL,
  googleBilling: GOOGLE_BILLING_REPORTS_URL,
} as const;
export type ExternalLink = (typeof EXTERNAL_LINKS)[keyof typeof EXTERNAL_LINKS];

export type TileHref = AdminRoute | `${AdminRoute}?${string}` | ExternalLink;

export type TileTone = 'default' | 'good' | 'warn' | 'danger' | 'muted';

export interface AdminTile {
  id: string;
  label: string;
  value: string;
  sub: string;
  href: TileHref;
  tone: TileTone;
}

export interface AdminSection {
  id: 'growth' | 'users' | 'money' | 'cost' | 'health' | 'comms' | 'tools';
  title: string;
  tiles: AdminTile[];
}

/** A dashboard read that either worked or says why it did not. */
export type Read<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Await a read without letting one failure blank the page — and without
 * hiding it: the tile that needed it says "read failed" and why.
 */
export async function settle<T>(label: string, p: Promise<T>): Promise<Read<T>> {
  try {
    return { ok: true, value: await p };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(`[admin] ${label} failed:`, error);
    return { ok: false, error };
  }
}

export interface AdminDashboardData {
  now: Date;
  overview: Read<{
    totalUsers: number;
    internalUsers: number;
    newUsers24h: number;
    newUsers7d: number;
    activeUsers24h: number;
    activeUsers7d: number;
    totalTrips: number;
    totalTemplates: number;
    totalLegs: number;
    totalVehicles: number;
    totalDeletedUsers: number;
  }>;
  topSpender: Read<{ name: string | null; email: string | null; microcents: number } | null>;
  chat: Read<{ trips: number; messages: number; lastAt: Date | null }>;
  paywallOn: Read<boolean>;
  promo: Read<{ issued: number; redeemed: number; open: number }>;
  anthropic: ProviderSpend<AnthropicCostData>;
  google: ProviderSpend<GoogleBillingData>;
  errors24h: Read<{ total: number; c4xx: number; c5xx: number }>;
  /** Anthropic failures in the last hour — the old red banner, now the tile's tone. */
  anthropicAlert: Read<{ failureCount: number } | null>;
  penny: Read<{ locked: boolean; worst: 'ok' | 'alert' | 'open' }>;
  jevMode: Read<'off' | 'compare' | 'on'>;
  announcements: Read<{ activeCount: number; totalCount: number }>;
  testUsers: { production: boolean; armed: boolean };
}

export function fmtUsd(usd: number): string {
  if (usd === 0) return '$0.00';
  return `$${usd.toFixed(Math.abs(usd) >= 1 ? 2 : 4)}`;
}

function fmtMoney(amount: number, currency: string): string {
  if (!/^[A-Z]{3}$/.test(currency)) return amount.toFixed(2);
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount);
}

export function fmtAgo(d: Date | null, now: Date): string {
  if (!d) return 'never';
  const s = Math.max(0, Math.round((now.getTime() - d.getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/** Same id/label/href whatever the read did; only value/sub/tone change. */
function tile(
  base: Pick<AdminTile, 'id' | 'label' | 'href'>,
  body: Pick<AdminTile, 'value' | 'sub'> & { tone?: TileTone }
): AdminTile {
  return { ...base, value: body.value, sub: body.sub, tone: body.tone ?? 'default' };
}

function fromRead<T>(
  base: Pick<AdminTile, 'id' | 'label' | 'href'>,
  read: Read<T>,
  ok: (v: T) => Pick<AdminTile, 'value' | 'sub'> & { tone?: TileTone }
): AdminTile {
  if (!read.ok) return tile(base, { value: '—', sub: `read failed: ${read.error}`, tone: 'danger' });
  return tile(base, ok(read.value));
}

function fromProvider<T>(
  base: Pick<AdminTile, 'id' | 'label' | 'href'>,
  spend: ProviderSpend<T>,
  ok: (v: T) => Pick<AdminTile, 'value' | 'sub'> & { tone?: TileTone }
): AdminTile {
  if (spend.status === 'not_configured') {
    return tile(base, { value: 'Not configured', sub: `set ${missingVars(spend.missing)}`, tone: 'muted' });
  }
  if (spend.status === 'error') return tile(base, { value: 'Error', sub: spend.message, tone: 'danger' });
  return tile(base, ok(spend.data));
}

/**
 * The missing variables, short enough for a fixed-size tile: one name as is;
 * several that share a prefix as `PREFIX_* (n vars)`. The full names are on
 * the tile's title and on /admin/cost.
 */
export function missingVars(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  let prefix = names[0];
  for (const n of names) while (!n.startsWith(prefix)) prefix = prefix.slice(0, -1);
  const cut = prefix.lastIndexOf('_');
  return cut > 0 ? `${prefix.slice(0, cut + 1)}* (${names.length} vars)` : names.join(' + ');
}

const JEV_LABEL = { off: 'HAIKU ONLY', compare: 'COMPARE', on: 'JEV FIRST' } as const;

export function buildAdminSections(d: AdminDashboardData): AdminSection[] {
  const o = d.overview;
  return [
    {
      id: 'growth',
      title: 'Growth',
      tiles: [
        fromRead({ id: 'new-signups', label: 'New signups · 24h', href: '/admin/signups' }, o, (v) => ({
          value: String(v.newUsers24h),
          sub: `${v.newUsers7d} in 7d`,
          tone: v.newUsers24h > 0 ? 'good' : 'default',
        })),
        fromRead({ id: 'active-users', label: 'Active users · 24h', href: '/admin/users?sort=active_desc' }, o, (v) => ({
          value: String(v.activeUsers24h),
          sub: `${v.activeUsers7d} in 7d`,
        })),
        fromRead({ id: 'total-users', label: 'Total users', href: '/admin/users' }, o, (v) => ({
          value: String(v.totalUsers),
          // Printed, not quietly subtracted: if this jumps, an internal-account
          // pattern has started matching real signups.
          sub: v.internalUsers > 0 ? `${v.internalUsers} internal not counted` : 'no internal accounts',
        })),
        fromRead({ id: 'deleted-accounts', label: 'Deleted accounts', href: '/admin/deleted' }, o, (v) => ({
          value: String(v.totalDeletedUsers),
          sub: 'churn, all time',
          tone: v.totalDeletedUsers > 0 ? 'warn' : 'default',
        })),
      ],
    },
    {
      id: 'users',
      title: 'Users',
      tiles: [
        fromRead({ id: 'top-spenders', label: 'Top spenders', href: '/admin/users?sort=spend_desc' }, d.topSpender, (v) =>
          v
            ? {
                value: v.name || v.email || '(unknown)',
                sub: `${fmtUsd(v.microcents / 1e8)} all time · list-price est.`,
              }
            : { value: 'Nobody yet', sub: 'no AI usage recorded' }
        ),
        fromRead({ id: 'active-trips', label: 'Active trips', href: '/admin/trips' }, o, (v) => ({
          value: String(v.totalTrips),
          sub: `${v.totalLegs} legs · ${v.totalTemplates} templates`,
        })),
        fromRead({ id: 'recent-chat', label: 'Recent chat · 24h', href: '/admin/chats' }, d.chat, (v) => ({
          value: `${v.trips} trip${v.trips === 1 ? '' : 's'}`,
          sub: `${v.messages} messages · last ${fmtAgo(v.lastAt, d.now)}`,
        })),
        fromRead({ id: 'total-vehicles', label: 'Total vehicles', href: '/admin/vehicles' }, o, (v) => ({
          value: String(v.totalVehicles),
          sub: 'across all accounts',
        })),
      ],
    },
    {
      id: 'money',
      title: 'Money',
      tiles: [
        fromRead({ id: 'paywall', label: 'Paywall', href: '/admin/paywall' }, d.paywallOn, (on) => ({
          value: on ? 'ON' : 'OFF',
          sub: on ? 'enforced for every account' : 'nobody is walled',
          tone: on ? 'good' : 'warn',
        })),
        fromRead({ id: 'promo-codes', label: 'Promo codes', href: '/admin/promo' }, d.promo, (v) => ({
          value: `${v.redeemed} / ${v.issued}`,
          sub: `redeemed of issued · ${v.open} still open`,
        })),
      ],
    },
    {
      id: 'cost',
      title: 'Cost',
      tiles: [
        fromProvider({ id: 'ai-spend-today', label: 'AI spend · today UTC', href: EXTERNAL_LINKS.anthropicCost }, d.anthropic, (v) => ({
          value: fmtUsd(v.todayUsd),
          sub: `Anthropic-billed · yesterday ${fmtUsd(v.yesterdayUsd)}`,
        })),
        fromProvider({ id: 'ai-spend-7d', label: 'AI spend · 7 UTC days', href: EXTERNAL_LINKS.anthropicCost }, d.anthropic, (v) => ({
          value: fmtUsd(v.last7DaysUsd),
          sub: 'Anthropic-billed · today + previous 6',
        })),
        fromProvider({ id: 'projected-month', label: 'Projected / mo', href: '/admin/cost' }, d.anthropic, (v) => ({
          value: fmtUsd(v.projectedMonthUsd),
          sub: 'Anthropic · 7 full UTC days × 30/7',
        })),
        fromProvider({ id: 'google-billable', label: 'Google · this month', href: EXTERNAL_LINKS.googleBilling }, d.google, (v) => ({
          value: fmtMoney(v.netAmount, v.currency),
          sub: `net of credits · billing export lags hours`,
        })),
        tile(
          { id: 'cost-breakdown', label: 'Cost breakdown', href: '/admin/cost' },
          { value: 'By day', sub: 'billed lines + per-feature estimate' }
        ),
      ],
    },
    {
      id: 'health',
      title: 'Health',
      tiles: [
        fromRead({ id: 'api-failures', label: 'API failures · 24h', href: '/admin/errors?since=24h' }, d.errors24h, (v) => {
          const alert = d.anthropicAlert.ok ? d.anthropicAlert.value : null;
          if (alert) {
            return { value: String(v.total), sub: `Anthropic failing: ${alert.failureCount} in the last hour`, tone: 'danger' };
          }
          return {
            value: String(v.total),
            sub: `${v.c4xx} 4xx · ${v.c5xx} 5xx · ${v.total - v.c4xx - v.c5xx} other`,
            tone: v.c5xx > 0 ? 'warn' : 'default',
          };
        }),
        fromRead({ id: 'penny-lockdown', label: 'Penny lockdown', href: '/admin/penny' }, d.penny, (v) =>
          v.locked
            ? { value: 'LOCKED', sub: 'manual switch — Penny refuses everyone', tone: 'danger' }
            : v.worst === 'open'
              ? { value: 'Breaker tripped', sub: 'non-admin requests refused', tone: 'danger' }
              : v.worst === 'alert'
                ? { value: 'Near a limit', sub: 'a breaker is over its alert line', tone: 'warn' }
                : { value: 'Normal', sub: 'all breakers under their alert lines', tone: 'good' }
        ),
        fromRead({ id: 'message-classifier', label: 'Message classifier', href: '/admin/classifier' }, d.jevMode, (m) => ({
          value: JEV_LABEL[m],
          sub: m === 'off' ? 'Jev off' : m === 'compare' ? 'Jev logged, Haiku decides' : 'Jev may settle T1',
        })),
      ],
    },
    {
      id: 'comms',
      title: 'Comms',
      tiles: [
        fromRead({ id: 'announcements', label: 'Announcements', href: '/admin/announcements' }, d.announcements, (v) => ({
          value: `${v.activeCount} active`,
          sub: `${v.totalCount} total · compose a new one`,
        })),
      ],
    },
    {
      id: 'tools',
      title: 'Tools',
      tiles: [
        tile(
          { id: 'test-users', label: 'Test users', href: '/admin/test-users' },
          d.testUsers.production
            ? { value: 'Off in prod', sub: 'use a preview deployment', tone: 'muted' }
            : d.testUsers.armed
              ? { value: 'Armed', sub: 'disposable paywall accounts' }
              : { value: 'Disarmed', sub: 'SUBSCRIPTION_TESTING unset', tone: 'muted' }
        ),
      ],
    },
  ];
}

export function isExternalHref(href: TileHref): href is ExternalLink {
  return href.startsWith('https://');
}
