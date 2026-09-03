import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * The iOS privacy manifest, guarded from the root test suite.
 *
 * `mobile/ios/PrivacyInfo.xcprivacy` is GENERATED and gitignored — `expo
 * prebuild --clean` rewrites the whole `ios/` tree on every build, locally and
 * on EAS. So the only durable statement of what this app declares is
 * `ios.privacyManifests` in `mobile/app.config.js`, and the only thing that can
 * notice it going missing is a test.
 *
 * The failure mode is specific and silent: a missing required-reason
 * declaration is not a build error, not a runtime error and not visible in the
 * app. It surfaces as an EMAIL from App Store Connect after the upload
 * (ITMS-91053, "Missing API declaration"), which is the worst possible moment
 * and the one place nobody is watching a test suite.
 *
 * Read as TEXT, never imported. `noMobileImportGuard.test.ts` forbids `src/`
 * importing from `mobile/` — CI's unit job runs `npm ci` at the root only, so
 * `mobile/node_modules` does not exist there and anything that transforms a
 * file under `mobile/` dies. That guard's own header says reading one as text
 * is fine and deliberately uncaught, which is what this does.
 */
const CONFIG = path.resolve(__dirname, '../../mobile/app.config.js');
const source = fs.readFileSync(CONFIG, 'utf8');

/**
 * Category -> the reason codes this app is entitled to claim.
 *
 * Every one was read off the privacy manifests of the dependencies actually in
 * `mobile/node_modules` (React Native, Expo's modules), not recalled from
 * memory. They belong to code compiled INTO the app target, which is why the
 * app target has to declare them: a dependency's own manifest speaks for the
 * dependency's binary, not for ours.
 */
const REQUIRED_REASONS: Record<string, string[]> = {
  NSPrivacyAccessedAPICategoryFileTimestamp: ['C617.1', '0A2A.1', '3B52.1'],
  NSPrivacyAccessedAPICategoryUserDefaults: ['CA92.1'],
  NSPrivacyAccessedAPICategoryDiskSpace: ['E174.1', '85F4.1'],
  NSPrivacyAccessedAPICategorySystemBootTime: ['35F9.1'],
};

/**
 * The eight things this app collects. Same eight rows as the nutrition-label
 * table in docs/design/app-store-listing.md §4 — if you change one, change
 * both, and change the answers in App Store Connect with them.
 *
 * The last two were missing until the dependency audit went past node_modules
 * and into a real `pod install`:
 *
 *   PurchaseHistory      `subscriptions` is keyed on `users.id` and holds the
 *                        product id, the original transaction id and the period
 *                        end — true of our own server whatever any SDK does.
 *                        It also turned out to be uncovered by RevenueCat's own
 *                        manifest, because neither `RevenueCat` nor
 *                        `PurchasesHybridCommon` builds its .xcprivacy into a
 *                        resource bundle the way React-Core and the Expo
 *                        modules do, so nothing aggregates it.
 *   OtherDiagnosticData  `ChatPanel`'s stream-error beacon to
 *                        `/api/analytics/client-error`, which requires a
 *                        session and lands in `usage_events` with a `user_id`.
 */
const COLLECTED = [
  'NSPrivacyCollectedDataTypeEmailAddress',
  'NSPrivacyCollectedDataTypeName',
  'NSPrivacyCollectedDataTypePreciseLocation',
  'NSPrivacyCollectedDataTypePhotosorVideos',
  'NSPrivacyCollectedDataTypeOtherUserContent',
  'NSPrivacyCollectedDataTypeUserID',
  'NSPrivacyCollectedDataTypePurchaseHistory',
  'NSPrivacyCollectedDataTypeOtherDiagnosticData',
];

describe('iOS privacy manifest', () => {
  it('is declared in app.config.js, not left to the generated ios/ tree', () => {
    expect(source).toContain('privacyManifests');
  });

  it.each(Object.entries(REQUIRED_REASONS))(
    'declares %s with its reason codes',
    (category, codes) => {
      expect(source).toContain(category);
      for (const code of codes) expect(source).toContain(`'${code}'`);
    }
  );

  it.each(COLLECTED)('declares collected data type %s', (type) => {
    expect(source).toContain(type);
  });

  it('answers the tracking question, and answers it no', () => {
    // An OMITTED NSPrivacyTracking is not the same as a false one: the first
    // is a question left blank, the second is an answer on the record.
    expect(source).toContain('NSPrivacyTracking: false');
    expect(source).toContain('NSPrivacyTrackingDomains: []');
  });

  it('has no collected data type marked as used for tracking', () => {
    // The day an analytics or ad SDK lands, one of these flips and this test is
    // the thing that says so — out loud, next to a reminder that the App Store
    // Connect questionnaire and §4 of the listing doc both have to move too.
    expect(source).not.toMatch(/NSPrivacyCollectedDataTypeTracking:\s*true/);
  });

  it('claims no required reason the app cannot defend', () => {
    // DDA9.1 is "display file timestamps to the person using the device" and
    // 8FFB.1 is "calculate absolute timestamps of events within the app". This
    // app does neither. They are here as named absences because the tempting
    // fix for a rejection is to paste in every code in the category, and that
    // is a claim, not a fix.
    expect(source).not.toContain("'DDA9.1'");
    expect(source).not.toContain("'8FFB.1'");
  });
});
