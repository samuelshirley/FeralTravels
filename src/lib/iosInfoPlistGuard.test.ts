import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { auditInfoPlist, resolveInfoPlist, ALLOWED_USAGE_KEYS } from '../../scripts/ios-usage-strings.mjs';

/**
 * The iOS purpose strings, as the binary carries them.
 *
 * Build 1.0 (12) shipped NSCameraUsageDescription, NSMicrophoneUsageDescription,
 * NSLocationAlwaysUsageDescription and NSFaceIDUsageDescription as
 * "Allow $(PRODUCT_NAME) to access your …", plus an AlwaysAndWhenInUse string
 * for a permission the app never asks for — all config-plugin DEFAULTS, none of
 * them in app.config.js's text. Guideline 5.1.1(ii)/(iii).
 *
 * So the check is over the RESOLVED config. Three layers:
 *   1. the audit itself, against the plist build 12 actually shipped (it must
 *      flag every one of those keys) and a clean one;
 *   2. the live resolved config, wherever mobile/node_modules is installed
 *      (locally; CI's unit job has none, so there it is the Mobile typecheck
 *      job's `node scripts/ios-usage-strings.mjs` step that runs it);
 *   3. that the CI step exists, so layer 2 cannot be quietly dropped.
 */

/** Read off FeralTravels.app/Info.plist of build 1.0 (12), 2026-10-20. */
const BUILD_12 = {
  NSCameraUsageDescription: 'Allow FeralTravels to access your camera',
  NSFaceIDUsageDescription: 'Allow FeralTravels to access your Face ID biometric data.',
  NSLocationAlwaysAndWhenInUseUsageDescription:
    'Feral Travels uses your location to anchor your trip progress and plan fuel stops along your route.',
  NSLocationAlwaysUsageDescription: 'Allow FeralTravels to access your location',
  NSLocationWhenInUseUsageDescription:
    'Feral Travels uses your location to anchor your trip progress and plan fuel stops along your route.',
  NSMicrophoneUsageDescription: 'Allow FeralTravels to access your microphone',
  NSPhotoLibraryUsageDescription:
    'Feral Travels lets you attach photos to your messages with Penny so she can see what you are looking at.',
  UIBackgroundModes: [],
};

const CLEAN = {
  NSLocationWhenInUseUsageDescription: 'Feral Travels plans fuel from where you are.',
  NSPhotoLibraryUsageDescription: 'Feral Travels lets you attach photos to Penny.',
  UIBackgroundModes: [],
};

const ROOT = path.resolve(__dirname, '../..');
const MOBILE = path.join(ROOT, 'mobile');
const HAS_MOBILE_DEPS = fs.existsSync(path.join(MOBILE, 'node_modules', 'expo-location'));

describe('auditInfoPlist', () => {
  it('flags every key build 12 should not have shipped', () => {
    const problems: string[] = auditInfoPlist(BUILD_12);
    for (const key of [
      'NSCameraUsageDescription',
      'NSMicrophoneUsageDescription',
      'NSLocationAlwaysUsageDescription',
      'NSLocationAlwaysAndWhenInUseUsageDescription',
      'NSFaceIDUsageDescription',
    ]) {
      expect(problems.some((p) => p.startsWith(key)), key).toBe(true);
    }
    expect(problems).toHaveLength(5);
  });

  it('passes a plist carrying only what the app asks for', () => {
    expect(auditInfoPlist(CLEAN)).toEqual([]);
  });

  it('flags an allowed key left at a plugin default', () => {
    const problems: string[] = auditInfoPlist({
      ...CLEAN,
      NSPhotoLibraryUsageDescription: 'Allow $(PRODUCT_NAME) to access your photos',
    });
    expect(problems).toEqual([expect.stringMatching(/^NSPhotoLibraryUsageDescription is a plugin default/)]);
  });

  it('flags a string that does not name the app', () => {
    expect(
      auditInfoPlist({ ...CLEAN, NSLocationWhenInUseUsageDescription: 'We need your location.' }),
    ).toEqual([expect.stringMatching(/does not name Feral Travels/)]);
  });

  it('flags a missing key the app needs — the launch prompt cannot run without it', () => {
    const { NSLocationWhenInUseUsageDescription: _gone, ...rest } = CLEAN;
    void _gone;
    expect(auditInfoPlist(rest)).toEqual([expect.stringMatching(/^NSLocationWhenInUseUsageDescription is missing/)]);
  });

  it('flags a background location or audio mode', () => {
    expect(auditInfoPlist({ ...CLEAN, UIBackgroundModes: ['location'] })).toHaveLength(1);
    expect(auditInfoPlist({ ...CLEAN, UIBackgroundModes: ['audio'] })).toHaveLength(1);
  });

  it('allows exactly the two keys the app uses', () => {
    expect([...ALLOWED_USAGE_KEYS].sort()).toEqual([
      'NSLocationWhenInUseUsageDescription',
      'NSPhotoLibraryUsageDescription',
    ]);
  });
});

describe.skipIf(!HAS_MOBILE_DEPS)('the resolved mobile config (needs mobile/node_modules)', () => {
  it('carries only specific purpose strings for permissions the app uses', () => {
    const plist = resolveInfoPlist(MOBILE);
    expect(auditInfoPlist(plist)).toEqual([]);
  }, 60_000);
});

describe('CI runs the resolved-config check', () => {
  it('the Mobile typecheck job runs scripts/ios-usage-strings.mjs', () => {
    const ci = fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');
    const start = ci.indexOf('\n  mobile:\n');
    expect(start).toBeGreaterThan(0);
    // Up to the next top-level job key, so a step in some OTHER job (one with
    // no mobile/node_modules, where the check would crash) does not count.
    const rest = ci.slice(start + 1);
    const next = rest.slice(1).search(/\n {2}[a-z][\w-]*:\n/);
    const mobileJob = next === -1 ? rest : rest.slice(0, next + 1);
    expect(mobileJob).toMatch(/run: node \.\.\/scripts\/ios-usage-strings\.mjs/);
  });
});
