/**
 * A no-op stand-in for the `server-only` package, used ONLY by CLI scripts.
 *
 * `server-only` exists to make a build fail when server code is pulled into a
 * client bundle. A `tsx` script is server code by definition — there is no
 * bundle and no browser — so the guard has nothing to protect there, and its
 * import-time throw was the reason `scripts/trial-account.ts` ended up
 * restating a regex that lives in `payments/testPurchase.ts`. Restating a
 * security boundary so a script can run is a worse trade than shimming the
 * guard the script does not need.
 *
 * Wired up in `tsconfig.scripts.json`, which is passed with `tsx --tsconfig`.
 * The app's own tsconfig is untouched, so nothing about the Next build or the
 * real guard changes.
 */
export {};
