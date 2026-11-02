import { redirect } from 'next/navigation';
import { auth } from '@/server/auth';
import { isAdmin } from '@/server/auth/guards';
import {
  getAdminOverview,
  getAnthropicHealthAlert,
  getChatPulse,
  getErrorCounts,
  getTopUsersAllTime,
} from '@/server/repos/admin';
import { getAnnouncementStats } from '@/server/repos/announcements';
import { globalJevMode } from '@/server/repos/jev';
import { breakerSnapshot, getPromoCodeStats, paywallEnabled, pennyLocked } from '@/server/payments';
import { testAccountsAvailable } from '@/server/payments/testAccountGate';
import { isProductionEnvironment } from '@/server/productionGuard';
import { readAnthropicSpend, readGoogleSpend } from '@/server/providerSpend';
import { requireWebAccess } from '@/server/auth/webAccess';
import AdminShell from './AdminShell';
import AdminTileGrid from './AdminTileGrid';
import { buildAdminSections, settle } from './tiles';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * The admin homepage: ONLY tiles (Sam, 2026-11-02, launch day). Every number
 * an operator checks in the morning, grouped Growth / Users / Money / Cost /
 * Health / Comms / Tools, and every tile opens its own screen — the map and
 * its no-dead-ends rule live in `tiles.ts`.
 *
 * Money comes from the PROVIDERS (`@/server/providerSpend`), never from our
 * `usage_events` arithmetic, which undercounts the real bill.
 * `adminTilesGuard.test.ts` holds this file to that, and to rendering nothing
 * but the tile grid.
 */
export default async function AdminPage() {
  // The web app is off for everyone but the admin (iOS-first, 2026-08-28).
  // Guarded by webAccessCoverage.test.ts — a new page without this line fails the suite.
  await requireWebAccess();
  const session = await auth();
  if (!session?.user) redirect('/login');
  // Silent redirect — no error page, no info leak that /admin even exists.
  if (!(await isAdmin(session.user.email))) redirect('/trips');

  const [overview, topSpender, chat, paywallOn, promo, anthropic, google, errors24h, anthropicAlert, penny, jevMode, announcements] =
    await Promise.all([
      settle('overview', getAdminOverview()),
      settle(
        'top spender',
        getTopUsersAllTime(1).then((rows) =>
          rows[0] ? { name: rows[0].name, email: rows[0].email, microcents: Number(rows[0].microcents) } : null
        )
      ),
      settle('chat pulse', getChatPulse(24)),
      settle('paywall switch', paywallEnabled()),
      settle('promo stats', getPromoCodeStats()),
      readAnthropicSpend(),
      readGoogleSpend(),
      settle('error counts', getErrorCounts(24)),
      settle('anthropic health', getAnthropicHealthAlert()),
      settle(
        'penny lockdown',
        // Uncached on purpose — see the penny page.
        Promise.all([pennyLocked(), breakerSnapshot()]).then(([locked, b]) => ({ locked, worst: b.worst }))
      ),
      settle('jev mode', globalJevMode()),
      settle('announcements', getAnnouncementStats()),
    ]);

  const sections = buildAdminSections({
    now: new Date(),
    overview,
    topSpender,
    chat,
    paywallOn,
    promo,
    anthropic,
    google,
    errors24h,
    anthropicAlert,
    penny,
    jevMode,
    announcements,
    testUsers: { production: isProductionEnvironment(), armed: testAccountsAvailable() },
  });

  return (
    <AdminShell home user={session.user} title="Admin" subtitle={`signed in as ${session.user.email}`}>
      <AdminTileGrid sections={sections} />
    </AdminShell>
  );
}
