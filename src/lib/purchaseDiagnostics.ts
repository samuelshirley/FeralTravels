import type { UnavailableReason } from './purchaseMode';

/**
 * The DEVELOPER's reading of an unavailable purchase sheet — five sentences,
 * one per reason, each naming where the fix lives.
 *
 * ── Why this is its own module ────────────────────────────────────────────
 *
 * These sentences used to be the copy the sheet showed EVERYONE, and one of
 * them told the reader the App Store was not offering the plans YET and that
 * the prices were not a checkout — a rejection if an App Review tester reads
 * it. The five-way split is worth keeping; showing it to a customer is not.
 *
 * So the app loads this file ONLY as `__DEV__ ? require(...) : null`. Metro
 * replaces `__DEV__` with `false` in a release bundle and folds the dead branch
 * away BEFORE it collects dependencies, so in a TestFlight or App Store build
 * this module — and every sentence in it — is not in the binary at all. Not
 * hidden: absent. Three things hold that in place:
 *
 *  - `purchaseCopyGuard.test.ts` fails if anything in mobile/ reaches this
 *    module any other way, or if a sentence from it appears anywhere else;
 *  - the Mobile typecheck CI job bundles the app in release mode and fails if
 *    `PURCHASE_DIAGNOSTICS_SENTINEL` is in the output;
 *  - the customer copy is `unavailableMessage` in `purchaseMode.ts`, which the
 *    same guard holds to a list of words a reviewer must never see.
 *
 * Mirrored into mobile/shared/ by `scripts/sync-shared.mjs`, like its sibling.
 */

/**
 * An ASCII marker the release-bundle check greps for. Hermes stores non-ASCII
 * strings as UTF-16, so the sentences themselves (em dashes, curly quotes) are
 * not reliably greppable in a bundle; this is. Rendered with the diagnostic so
 * it cannot be dropped as unused.
 */
export const PURCHASE_DIAGNOSTICS_SENTINEL = 'PURCHASE_DIAGNOSTICS_DEV_ONLY';

export function unavailableDiagnostic(reason: UnavailableReason): string {
  switch (reason) {
    case 'no_key':
      return (
        'no_key: this build has no RevenueCat key (EXPO_PUBLIC_REVENUECAT_IOS_KEY missing or not ' +
        'appl_…). Compiled in — fix eas.json and make a new native build; an OTA cannot.'
      );
    case 'store_empty':
      return (
        'store_empty: RevenueCat served the offering, and StoreKit resolved none of its products ' +
        '(CONFIGURATION_ERROR, or an offering with no packages). App Store Connect, not code: ' +
        'run scripts/storekit-probe.sh — it asks StoreKit directly and prints which ids are invalid.'
      );
    case 'store_error':
      return (
        'store_error: the offerings call threw — no network, a rejected key, or a RevenueCat ' +
        'outage. The Metro log has the SDK error.'
      );
    case 'no_match':
      return (
        'no_match: the store returned packages, and none of their product ids is in PRODUCTS ' +
        '(src/server/payments/constants.ts). Fix the ids in the RevenueCat offering or constants.ts.'
      );
    case 'no_plans':
      return (
        'no_plans: GET /api/me/entitlement failed, so the server gave the sheet nothing to sell. ' +
        'Network, or the API — check the server log.'
      );
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}
