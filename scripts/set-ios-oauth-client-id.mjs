#!/usr/bin/env node
/**
 * Put the Google iOS OAuth client ID everywhere it has to be, in one shot.
 *
 * It belongs in three places that must agree, and the app fails differently
 * depending on which one you forget: mobile/.env (local prebuild + run),
 * mobile/eas.json preview + production profiles (cloud builds — EAS does not
 * read an uncommitted .env), and Vercel (the server, which checks the token's
 * audience against it).
 *
 * Usage — pass the id, or leave it off and it reads the clipboard:
 *   node scripts/set-ios-oauth-client-id.mjs 1234-abc.apps.googleusercontent.com
 *   node scripts/set-ios-oauth-client-id.mjs
 *
 * An iOS client ID is NOT a secret — it ships inside the app binary and has no
 * client secret — so committing it in eas.json is fine.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV_PATH = path.join(repoRoot, 'mobile/.env');
const EAS_PATH = path.join(repoRoot, 'mobile/eas.json');

const SHAPE = /^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/;

function fromClipboard() {
  try {
    return execSync('pbpaste', { encoding: 'utf-8' }).trim();
  } catch {
    return '';
  }
}

const clientId = (process.argv[2] || fromClipboard()).trim();

if (!clientId) {
  console.error('No client id given and the clipboard is empty.');
  console.error('Google Cloud → Credentials → OAuth client ID → iOS (bundle id com.feraltravels.app).');
  process.exit(1);
}

if (!SHAPE.test(clientId)) {
  // Catch the two mistakes that cost an hour: pasting the WEB client id's
  // secret alongside it, or pasting the reversed scheme form.
  console.error(`That does not look like an iOS OAuth client id:\n  ${clientId}`);
  console.error('Expected something like 1234567890-abcdef.apps.googleusercontent.com');
  process.exit(1);
}

// --- mobile/.env: rewrite our key, leave anything else alone ---------------
const KEYS = {
  EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID: clientId,
  EXPO_PUBLIC_ENABLE_APPLE_SIGNIN: '1',
};

const existing = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf-8') : '';
const kept = existing
  .split('\n')
  .filter((line) => line.trim() && !Object.keys(KEYS).some((k) => line.startsWith(`${k}=`)));
const envOut = [...kept, ...Object.entries(KEYS).map(([k, v]) => `${k}=${v}`)].join('\n') + '\n';
writeFileSync(ENV_PATH, envOut);

// --- mobile/eas.json: the cloud build profiles ----------------------------
const eas = JSON.parse(readFileSync(EAS_PATH, 'utf-8'));
for (const profile of ['preview', 'production']) {
  if (!eas.build?.[profile]) continue;
  eas.build[profile].env = { ...(eas.build[profile].env ?? {}), ...KEYS };
}
writeFileSync(EAS_PATH, JSON.stringify(eas, null, 2) + '\n');

console.log(`Wrote ${path.relative(repoRoot, ENV_PATH)} and the preview + production profiles in ${path.relative(repoRoot, EAS_PATH)}.`);
console.log('\nStill to do — neither can be done from here:');
console.log(`  1. Vercel env (prod AND preview):  GOOGLE_IOS_CLIENT_ID=${clientId}`);
console.log('  2. A NEW native build. The reversed client id is a CFBundleURLScheme,');
console.log('     so an OTA update cannot deliver it:');
console.log('       cd mobile && npx expo prebuild --clean && npx expo run:ios');
