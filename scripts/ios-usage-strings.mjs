#!/usr/bin/env node
/**
 * The iOS purpose strings, checked on the RESOLVED config — what `expo
 * prebuild` actually writes into Info.plist — not on app.config.js's text.
 *
 * WHY THE RESOLVED CONFIG. Build 1.0 (12) shipped five purpose strings nobody
 * wrote: config plugins add a generic default ("Allow $(PRODUCT_NAME) to access
 * your camera") for every permission their module COULD use, unless the plugin
 * option says otherwise. None of them appear anywhere in app.config.js, so no
 * check over that file could ever have seen them. Guideline 5.1.1(ii)/(iii):
 * a generic string, or a key for data the app never asks for, is a rejection.
 *
 * Two rules, both against the plist a build would ship:
 *
 *   1. ONLY the keys in ALLOWED may exist. A `*UsageDescription` key is a claim
 *      that the app asks for that data; a new one is a product decision, made
 *      by adding it here with the reason, never by a dependency's default.
 *   2. No string may be a plugin default — `$(PRODUCT_NAME)`, or the
 *      "Allow <app> to access your …" boilerplate every Expo plugin uses — and
 *      each must name the app, so it reads as ours in the system dialog.
 *
 * Also: no background mode that would claim background location or audio.
 *
 *   node scripts/ios-usage-strings.mjs        # resolves mobile/'s config, exits 1 on any violation
 *
 * Needs mobile/node_modules (the plugins ARE the thing being checked), so CI
 * runs it in the Mobile typecheck job; the unit suite tests `auditInfoPlist`
 * against fixtures, and against the live config wherever mobile/ is installed.
 */
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Every purpose string the binary may carry, and why.
 *
 *   NSLocationWhenInUseUsageDescription  The launch prompt (app/index.tsx) —
 *       Finn plans fuel from where you are; the trip knows today's stop.
 *   NSPhotoLibraryUsageDescription       Never PROMPTED (PHPicker needs no
 *       permission), but expo-image-picker links PHPhotoLibrary.requestAuthorization,
 *       and a referenced protected API with no string is refused at upload
 *       (ITMS-90683). Its string is true: photos are attached to Penny's chat.
 */
export const ALLOWED_USAGE_KEYS = [
  'NSLocationWhenInUseUsageDescription',
  'NSPhotoLibraryUsageDescription',
];

/** Background modes that are each a claim App Review asks about. */
export const FORBIDDEN_BACKGROUND_MODES = ['location', 'audio', 'fetch', 'processing'];

const APP_NAME = 'Feral Travels';

/**
 * @param {Record<string, unknown>} infoPlist
 * @returns {string[]} one human sentence per violation; empty means clean.
 */
export function auditInfoPlist(infoPlist) {
  const problems = [];
  for (const [key, value] of Object.entries(infoPlist)) {
    if (!/UsageDescription$/.test(key)) continue;
    if (!ALLOWED_USAGE_KEYS.includes(key)) {
      problems.push(
        `${key} is in Info.plist but the app does not ask for it (value: ${JSON.stringify(value)}). ` +
          'Set the owning plugin\'s option to false in mobile/app.config.js.',
      );
      continue;
    }
    const text = typeof value === 'string' ? value : '';
    if (text.includes('$(PRODUCT_NAME)') || /^Allow\b.*\bto access your\b/i.test(text)) {
      problems.push(`${key} is a plugin default (${JSON.stringify(text)}), not a purpose.`);
    } else if (!text.includes(APP_NAME)) {
      problems.push(`${key} does not name ${APP_NAME}: ${JSON.stringify(text)}`);
    }
  }
  for (const key of ALLOWED_USAGE_KEYS) {
    if (typeof infoPlist[key] !== 'string' || !infoPlist[key]) {
      problems.push(`${key} is missing — the app needs it (see ALLOWED_USAGE_KEYS).`);
    }
  }
  const modes = Array.isArray(infoPlist.UIBackgroundModes) ? infoPlist.UIBackgroundModes : [];
  for (const mode of modes) {
    if (FORBIDDEN_BACKGROUND_MODES.includes(mode)) {
      problems.push(`UIBackgroundModes contains "${mode}" — nothing in the app runs in the background.`);
    }
  }
  return problems;
}

/** The Info.plist `expo prebuild` would write, from mobile/'s installed plugins. */
export function resolveInfoPlist(mobileDir) {
  const out = execFileSync('npx', ['expo', 'config', '--type', 'introspect', '--json'], {
    cwd: mobileDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    // EAS_BUILD_PROFILE unset: app.config.js's RevenueCat check only applies
    // to shipping profiles, and the plist does not depend on it.
    env: { ...process.env, EAS_BUILD_PROFILE: '' },
  });
  return JSON.parse(out).ios.infoPlist;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const mobileDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'mobile');
  const plist = resolveInfoPlist(mobileDir);
  const problems = auditInfoPlist(plist);
  for (const key of Object.keys(plist).filter((k) => /UsageDescription$/.test(k))) {
    console.log(`${key} = ${JSON.stringify(plist[key])}`);
  }
  if (problems.length) {
    for (const p of problems) console.error(`::error::${p}`);
    process.exit(1);
  }
  console.log('Info.plist purpose strings: clean.');
}
