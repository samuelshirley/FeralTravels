import 'server-only';
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { db } from '@/server/db/client';
import { usageEvents } from '@/server/db/schema';
import type { DataSource } from '@/lib/dataSourceRateLimit';

/**
 * Read-side for the admin "Fuel data sources" dashboard. Reads the rate-limit
 * events recorded by `dataSourceAlerts.reportRateLimit` from `usage_events`.
 */

const PROVIDER: Record<DataSource, string> = {
  overpass: 'datasource:overpass:rate-limit',
  osrm: 'datasource:osrm:rate-limit',
};
const ALL_PROVIDERS = Object.values(PROVIDER);

export interface DataSourceHealthRow {
  source: DataSource;
  /** Free public endpoint default + whether an override env is configured. */
  endpoint: string;
  selfHosted: boolean;
  rateLimited24h: number;
  rateLimited7d: number;
  lastRateLimitedAt: string | null;
}

export interface RecentRateLimit {
  source: DataSource;
  createdAt: string;
  detail: string | null;
}

async function countSince(provider: string, since: Date): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`COUNT(*)::int` })
    .from(usageEvents)
    .where(and(eq(usageEvents.provider, provider), gte(usageEvents.createdAt, since)));
  return Number(rows[0]?.n ?? 0);
}

async function lastAt(provider: string): Promise<string | null> {
  const rows = await db
    .select({ createdAt: usageEvents.createdAt })
    .from(usageEvents)
    .where(eq(usageEvents.provider, provider))
    .orderBy(desc(usageEvents.createdAt))
    .limit(1);
  return rows[0]?.createdAt ? rows[0].createdAt.toISOString() : null;
}

export async function getDataSourceHealth(): Promise<{
  sources: DataSourceHealthRow[];
  recent: RecentRateLimit[];
}> {
  const now = Date.now();
  const since24 = new Date(now - 24 * 60 * 60 * 1000);
  const since7d = new Date(now - 7 * 24 * 60 * 60 * 1000);

  const sources: DataSourceHealthRow[] = [];
  for (const source of Object.keys(PROVIDER) as DataSource[]) {
    const provider = PROVIDER[source];
    const [c24, c7, last] = await Promise.all([
      countSince(provider, since24),
      countSince(provider, since7d),
      lastAt(provider),
    ]);
    const overrideEnv = source === 'overpass' ? process.env.OVERPASS_ENDPOINT : process.env.OSRM_ENDPOINT;
    const selfHosted = !!overrideEnv?.trim();
    sources.push({
      source,
      endpoint: selfHosted
        ? (overrideEnv as string)
        : source === 'overpass'
          ? 'overpass-api.de (public)'
          : 'router.project-osrm.org (public)',
      selfHosted,
      rateLimited24h: c24,
      rateLimited7d: c7,
      lastRateLimitedAt: last,
    });
  }

  const recentRows = await db
    .select({
      provider: usageEvents.provider,
      createdAt: usageEvents.createdAt,
      errorMessage: usageEvents.errorMessage,
    })
    .from(usageEvents)
    .where(inArray(usageEvents.provider, ALL_PROVIDERS))
    .orderBy(desc(usageEvents.createdAt))
    .limit(25);

  const recent: RecentRateLimit[] = recentRows.map((r) => ({
    source: r.provider.includes('overpass') ? 'overpass' : 'osrm',
    createdAt: r.createdAt.toISOString(),
    detail: r.errorMessage,
  }));

  return { sources, recent };
}
