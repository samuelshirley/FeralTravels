import 'server-only';
import { and, eq, gte, sql } from 'drizzle-orm';
import { db } from '@/server/db/client';
import { usageEvents } from '@/server/db/schema';
import { CAP_WINDOW_DAYS } from './constants';

/**
 * Anthropic spend for one user over the rolling cap window.
 *
 * TWO deliberate narrowings, both of which change the answer:
 *
 * 1. **`provider LIKE 'anthropic%'`, not `= 'anthropic'`.** The column is
 *    namespaced — `anthropic:accounting-write-failed` rows exist precisely
 *    because the primary insert threw, and they are real money we nearly lost
 *    track of. Excluding them under-counts exactly the users we most want to
 *    see.
 *
 * 2. **Google is excluded entirely.** `logGooglePlacesUsage` stores the GROSS
 *    list-price estimate; Google's free tier resets monthly across every row
 *    and can only be subtracted at aggregate time. Summing it in would count
 *    money nobody was ever billed for and block users who cost us zero.
 *    Google spend still belongs in the admin panel — it just must not gate
 *    anything.
 *
 * Rolling 12 months rather than per calendar month, for monthly and annual
 * subscribers alike: someone who plans one big trip in July and nothing else
 * would blow a monthly allowance while costing us almost nothing across the
 * year.
 */
export async function anthropicMicrocentsInWindow(
  userId: string,
  windowDays = CAP_WINDOW_DAYS
): Promise<number> {
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
  const rows = await db
    .select({
      microcents: sql<number>`COALESCE(SUM(${usageEvents.costMicrocents}), 0)`,
    })
    .from(usageEvents)
    .where(
      and(
        eq(usageEvents.userId, userId),
        gte(usageEvents.createdAt, since),
        sql`${usageEvents.provider} LIKE 'anthropic%'`
      )
    );
  return Number(rows[0]?.microcents ?? 0);
}
