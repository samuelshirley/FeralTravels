import { request, type APIRequestContext, type Page } from '@playwright/test';
import { testEndpointHeaders } from './constants';
import type { EntitlementPayload } from '../../src/types/entitlement';

/**
 * Driving `/api/test/subscription` — the fixture endpoint that ages an
 * account, sets its comp flag, plants synthetic Anthropic spend and writes a
 * subscription row.
 *
 * Same shape as test-trip.ts: a standalone request context, the guarded
 * endpoint, no raw SQL in a spec and no session involved. The endpoint mints
 * nothing — every spec below still signs in through the real OTP flow.
 */
function targetBaseUrl(): string {
  return process.env.E2E_BASE_URL || `http://localhost:${process.env.E2E_PORT || 4444}`;
}

async function withApi<T>(fn: (ctx: APIRequestContext) => Promise<T>): Promise<T> {
  const ctx = await request.newContext({
    baseURL: targetBaseUrl(),
    extraHTTPHeaders: testEndpointHeaders(),
  });
  try {
    return await fn(ctx);
  } finally {
    await ctx.dispose();
  }
}

export interface SubscriptionFixture {
  /**
   * NOT optional, and that is the single most important line in this file.
   *
   * `isCompedEmail` (src/server/payments/comped.ts) matches
   * `playwright-*@e2e.feraltravels.com`, so every address this suite uses is
   * on the comp list by design — and `resolveAccountState` returns `comped`
   * before it looks at age, spend or subscription. A paywall spec that let
   * this default would set up a day-30 account with $9 of spend, watch the app
   * cheerfully let it in, and pass. Every paywall assertion in the file would
   * be an assertion about nothing.
   *
   * So it is required by the TypeScript type here, required by the Zod schema
   * on the route, and every call below passes it literally. The backstop is
   * that each spec also asserts the resolved `state` from
   * `GET /api/me/entitlement`: if comping ever wins, the state comes back
   * `'comped'` and the spec fails loudly instead of passing quietly.
   */
  comped: boolean;
  createdAtDaysAgo?: number;
  anthropicSpendUsd?: number;
  /**
   * Default true on the server. Crossing $2 or $8.50 mails
   * support@feraltravels.com, and CI crossing both on every push is a real
   * inbox filling with fake spend on addresses that cannot receive mail. The
   * endpoint pre-claims the `usage_alerts` row, which is the same mechanism
   * that stops a genuinely capped user mailing support a hundred times.
   */
  suppressThresholdAlerts?: boolean;
  subscription?: {
    status: 'active' | 'grace' | 'cancelled' | 'expired' | 'refunded' | 'revoked';
    source?: 'apple_iap' | 'promo' | 'admin' | 'fake';
    productId?: string | null;
    autoRenew?: boolean;
    currentPeriodEndDaysFromNow?: number | null;
  } | null;
}

export interface SubscriptionFixtureResult {
  userId: string;
  createdAt: string;
  comped: boolean;
  anthropicMicrocents: number;
  subscriptionStatus: string | null;
  currentPeriodEnd: string | null;
}

/**
 * Put `email` into an account state.
 *
 * Call this AFTER signing in, not before. Nothing in the OTP path rewrites
 * `created_at` or `comped` today — but the Auth.js `signIn` event DOES call
 * `syncCompedFlagOnSignIn`, and the day someone gives the OTP path the same
 * treatment (which would be a fix, not a bug), state written before sign-in
 * would be silently reverted by the sign-in itself. Writing it afterwards
 * cannot be undone by anything the login does.
 */
export async function setSubscriptionState(
  email: string,
  fixture: SubscriptionFixture,
): Promise<SubscriptionFixtureResult> {
  return withApi(async (ctx) => {
    const res = await ctx.post('/api/test/subscription', { data: { email, ...fixture } });
    if (!res.ok()) {
      throw new Error(
        `[e2e/subscription] set state failed (${res.status()}): ${await res.text()}. ` +
          `404 means E2E_TEST_ENDPOINTS=1 is missing on the target, or x-e2e-test-secret ` +
          `doesn't match. 400 means the address didn't match the fixture pattern.`,
      );
    }
    return (await res.json()) as SubscriptionFixtureResult;
  });
}

/**
 * The server's own verdict, read through the signed-in page context.
 *
 * `GET /api/me/entitlement` is ungated on purpose — a paywalled user has to be
 * able to learn WHY — which makes it the one place a spec can read the
 * resolved state rather than infer it from what did or didn't render.
 */
export async function readEntitlement(page: Page): Promise<EntitlementPayload> {
  const res = await page.request.get('/api/me/entitlement');
  if (!res.ok()) {
    throw new Error(`[e2e/subscription] GET /api/me/entitlement (${res.status()}): ${await res.text()}`);
  }
  return (await res.json()) as EntitlementPayload;
}

/**
 * Try to create a trip the way the "+ New trip" button does, and report what
 * the SERVER said.
 *
 * The button's presence is a courtesy; `POST /api/trips` is the authority and
 * refuses on its own regardless of what the page drew. Every spec that claims
 * creation is blocked (or allowed) asserts on this, not on the button.
 */
export async function attemptCreateTrip(
  page: Page,
  name: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await page.request.post('/api/trips', { data: { name } });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status(), body };
}
