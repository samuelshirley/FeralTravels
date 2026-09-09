import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The iOS bundle id is `com.feraltravels.ios`, everywhere it appears. Decision H13.
 *
 * Uploading a TestFlight build binds a bundle id to the account that uploaded
 * it, FOREVER (confirmed with Apple DTS), and one was uploaded under the old US
 * team — so `com.feraltravels.app` is permanently unusable for iOS and the
 * rename was not cosmetic.
 *
 * The id is not only a build setting. It is the AUDIENCE Apple ID tokens are
 * checked against, the Maestro APP_ID in CI and the local runner, and the prefix
 * of both product ids — which live in `constants.ts` AND in the StoreKit file,
 * where a mismatch produces the same empty offering a real misconfiguration
 * does. Android deliberately stays `com.feraltravels.app`: the binding is
 * Apple's, Play has never seen the id, and a second rename with no reason is
 * not a tidy-up.
 */

const ROOT = join(__dirname, '..', '..');
const IOS = 'com.feraltravels.ios';
const OLD = 'com.feraltravels.app';
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

describe('the iOS bundle id', () => {
  it('is the audience Apple ID tokens are verified against', () => {
    expect(read('src/server/auth/oauthIdentity.ts')).toContain(`'${IOS}'`);
  });

  it('is the app config bundleIdentifier', () => {
    expect(read('mobile/app.config.js')).toContain(`bundleIdentifier: '${IOS}'`);
  });

  it('prefixes both product ids, in the server list AND the StoreKit file', () => {
    const constants = read('src/server/payments/constants.ts');
    const storekit = read('mobile/storekit/FeralTravels.storekit');
    for (const suffix of ['monthly', 'annual']) {
      expect(constants, `constants.ts is missing ${IOS}.${suffix}`).toContain(`${IOS}.${suffix}`);
      expect(storekit, `the StoreKit file is missing ${IOS}.${suffix}`).toContain(
        `${IOS}.${suffix}`,
      );
    }
  });

  it('is the Maestro APP_ID in CI and in the local runner', () => {
    expect(read('.github/workflows/ci.yml')).toContain(IOS);
    expect(read('scripts/ios-e2e-local.sh')).toContain(IOS);
  });
});

describe('the retired id', () => {
  it('survives only as the Android package', () => {
    // Android keeps it deliberately; iOS can never use it again.
    const config = read('mobile/app.config.js');
    expect(config).toContain(`package: '${OLD}'`);
    expect(config).not.toContain(`bundleIdentifier: '${OLD}'`);
  });

  it('is not a product-id prefix anywhere in the shipped app', () => {
    for (const rel of ['src/server/payments/constants.ts', 'mobile/storekit/FeralTravels.storekit']) {
      expect(read(rel), `${rel} still names the retired bundle id`).not.toContain(`${OLD}.`);
    }
  });
});
