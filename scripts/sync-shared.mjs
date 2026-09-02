// Mirrors the DOM-free domain modules from the Next app into mobile/shared/.
// Canonical source is src/lib + src/types — never edit mobile/shared/ by hand.
//
// `npm run sync-shared` rewrites the mirror; `npm run check:shared` fails if it
// has drifted (src/lib/sharedMirror.test.ts, so it also runs as part of the
// normal unit suite and gates every PR). Both matter more than they used to:
// the Mobile workflow now publishes mobile/ over the air on merge, so a stale
// mirror ships straight to devices instead of waiting for someone to notice.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
export const SHARED_FILES = [
  ['src/types/trip.ts', 'mobile/shared/types/trip.ts'],
  ['src/types/entitlement.ts', 'mobile/shared/types/entitlement.ts'],
  ['src/lib/units.ts', 'mobile/shared/lib/units.ts'],
  ['src/lib/maps.ts', 'mobile/shared/lib/maps.ts'],
  ['src/lib/coords.ts', 'mobile/shared/lib/coords.ts'],
  ['src/lib/dates.ts', 'mobile/shared/lib/dates.ts'],
  ['src/lib/dayModel.ts', 'mobile/shared/lib/dayModel.ts'],
  ['src/lib/paywallNotice.ts', 'mobile/shared/lib/paywallNotice.ts'],
  ['src/lib/tripCompletion.ts', 'mobile/shared/lib/tripCompletion.ts'],
  ['src/lib/legSegmentGrouping.ts', 'mobile/shared/lib/legSegmentGrouping.ts'],
  ['src/lib/fuelPlanErrorSemantics.ts', 'mobile/shared/lib/fuelPlanErrorSemantics.ts'],
  ['src/lib/vehicleProfile.ts', 'mobile/shared/lib/vehicleProfile.ts'],
  ['src/lib/vehicleNumericCoercion.ts', 'mobile/shared/lib/vehicleNumericCoercion.ts'],
  ['src/lib/validation.ts', 'mobile/shared/lib/validation.ts'],
  ['src/lib/polyline.ts', 'mobile/shared/lib/polyline.ts'],
  ['src/lib/mapClustering.ts', 'mobile/shared/lib/mapClustering.ts'],
  ['src/lib/useNextStop.ts', 'mobile/shared/lib/useNextStop.ts'],
  ['src/lib/sillyErrors.ts', 'mobile/shared/lib/sillyErrors.ts'],
  ['src/lib/models.ts', 'mobile/shared/lib/models.ts'],
  ['src/lib/accountDeletion.ts', 'mobile/shared/lib/accountDeletion.ts'],
  // Both halves of the promo flow. The app must normalize a typed code exactly
  // as the server does — if the two disagreed, a user would type something the
  // app accepts and the server rejects, and the error would read as a bad code
  // rather than a bug. The copy travels for the reason nativeErrorCopyGuard
  // exists: an error code with no copy in a client shows "Something went wrong".
  ['src/lib/promoCode.ts', 'mobile/shared/lib/promoCode.ts'],
  ['src/lib/promoCopy.ts', 'mobile/shared/lib/promoCopy.ts'],
  // The in-app-purchase vocabulary and its copy, plus the rule for how long the
  // app waits on the webhook. Nothing on the web can buy anything, so these
  // live in src/lib for ONE reason: the root vitest project is the only test
  // runner this repo has, and `mobile/lib/purchases.ts` cannot be tested by it
  // (it imports react-native-purchases, and CI's unit job installs no
  // mobile/node_modules). Same trade as paywallNotice.ts. The parts that DO
  // need the SDK — the PURCHASES_ERROR_CODE mapping — deliberately stay over
  // there, where `tsc --noEmit` checks the enum member names against the real
  // package instead of against a copy of them.
  ['src/lib/purchaseOutcome.ts', 'mobile/shared/lib/purchaseOutcome.ts'],
  ['src/lib/entitlementPolling.ts', 'mobile/shared/lib/entitlementPolling.ts'],
  // The Settings -> Plan status line. Mirrored so the two clients cannot end up
  // describing the same twelve account states differently, and living in
  // src/lib for the same reason as the two above: the root vitest project is
  // the only test runner, and its exhaustive switch is worth a test.
  ['src/lib/planStatusLine.ts', 'mobile/shared/lib/planStatusLine.ts'],
];
// The mirror keeps `@/` specifiers working by rewriting them to relative paths.
export function transform(source, destRel) {
  // Always '..': the mirror is exactly two sibling directories
  // (mobile/shared/lib and mobile/shared/types), so a file in either one
  // reaches the other by going up exactly once. Kept as a named constant
  // rather than inlined because the ternary it replaced had the same value in
  // both branches, which read like a bug every time.
  const depth = '..';
  void destRel;
  return (
    source
      .replace(/from '@\/types\//g, `from '${depth}/types/`)
      .replace(/from '@\/lib\//g, `from '${depth}/lib/`)
      /**
       * The one PLATFORM SEAM in the mirror. useNextStop needs a location
       * provider, and each platform has its own: the web's React context lives
       * at src/components/DeviceLocationContext.tsx, the native one at
       * mobile/lib/location.tsx. `@/` means the mobile root over there, so this
       * resolves correctly without the shared file knowing which platform it
       * is on.
       *
       * MUST run after the '@/lib/' rule above, or the '@/lib/location' this
       * produces would itself be rewritten to '../lib/location' — i.e. a
       * non-existent mobile/shared/lib/location. That ordering is the whole
       * reason these are chained rather than looped over a map.
       *
       * This rewrite was previously missing and the mirrored file carried the
       * corrected import by hand, so the first successful sync would have
       * overwritten it with an unresolvable path.
       */
      .replace(
        /from '@\/components\/DeviceLocationContext'/g,
        "from '@/lib/location'"
      )
      .replace(/^'use client';\n/m, '')
  );
}
if (import.meta.url === `file://${process.argv[1]}`) {
  for (const [src, dest] of SHARED_FILES) {
    if (!existsSync(src)) { console.error(`missing ${src}`); process.exit(1); }
    mkdirSync(dirname(dest), { recursive: true });
    const out = transform(readFileSync(src, 'utf8'), dest);
    // Was `require('node:fs').writeFileSync(...)`, which is a ReferenceError in
    // an ESM .mjs — the script threw on the FIRST file, so it had never
    // successfully synced anything.
    writeFileSync(dest, out);
    console.log(`synced ${src} -> ${dest}`);
  }
}
