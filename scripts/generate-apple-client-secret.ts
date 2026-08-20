/**
 * Mint the AUTH_APPLE_SECRET for Sign in with Apple on the web.
 *
 * Apple is the odd one out: its "client secret" is not a string you copy from
 * a console, it is a short-lived ES256 JWT you sign yourself with a .p8 key.
 * Apple caps the lifetime at SIX MONTHS. When it lapses, sign-in fails with a
 * bare `invalid_client` and nothing in the codebase has changed — which is
 * exactly the kind of failure nobody diagnoses quickly at 11pm. Re-run this
 * before the expiry printed at the end and update the env var.
 *
 * Usage — it prompts for anything not already in the environment:
 *   npx tsx scripts/generate-apple-client-secret.ts
 *
 * Where each value comes from (developer.apple.com → Certificates, IDs & Profiles):
 *   APPLE_TEAM_ID          Membership details → Team ID.
 *   APPLE_SERVICES_ID      Identifiers → Services IDs. This is the *web*
 *                          identifier and is NOT the app's bundle id — the
 *                          native iOS flow uses the bundle id instead.
 *                          Its Return URL must be
 *                          https://www.feraltravels.com/api/auth/callback/apple
 *   APPLE_KEY_ID           Keys → the key you enabled Sign in with Apple on.
 *   APPLE_PRIVATE_KEY_PATH the .p8 that Apple lets you download exactly once.
 *
 * The .p8 is a credential: keep it out of the repo and out of the shell
 * history. This script never prints it.
 */
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { SignJWT, importPKCS8 } from 'jose';

const MAX_LIFETIME_SECONDS = 15777000; // Apple's hard ceiling: ~6 months.

const rl = createInterface({ input: stdin, output: stdout });

/**
 * Env var if it is set, otherwise ask. Prompting rather than failing means
 * this is one command to run, with nothing to substitute by hand — and the
 * values never end up in shell history.
 */
async function required(name: string, prompt: string): Promise<string> {
  const fromEnv = process.env[name]?.trim();
  if (fromEnv) return fromEnv;

  const answer = (await rl.question(`${prompt}\n  ${name}: `)).trim();
  if (!answer) {
    console.error(`\n${name} is required — see the usage block at the top of this file.`);
    process.exit(1);
  }
  return answer;
}

async function main() {
  const teamId = await required('APPLE_TEAM_ID', 'Membership details -> Team ID');
  const keyId = await required('APPLE_KEY_ID', 'Keys -> the key with Sign in with Apple enabled');
  const servicesId = await required(
    'APPLE_SERVICES_ID',
    'Identifiers -> Services IDs (the WEB identifier, not the app bundle id)'
  );
  const keyPath = await required(
    'APPLE_PRIVATE_KEY_PATH',
    'Path to the .p8 Apple let you download once'
  );
  rl.close();

  let pkcs8: string;
  try {
    pkcs8 = readFileSync(keyPath, 'utf-8');
  } catch {
    console.error(`Could not read the private key at ${keyPath}`);
    process.exit(1);
  }

  const key = await importPKCS8(pkcs8, 'ES256');
  const now = Math.floor(Date.now() / 1000);
  const exp = now + MAX_LIFETIME_SECONDS;

  const secret = await new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: keyId })
    .setIssuer(teamId)
    .setIssuedAt(now)
    .setExpirationTime(exp)
    // Apple requires this exact audience; the subject is the Services ID.
    .setAudience('https://appleid.apple.com')
    .setSubject(servicesId)
    .sign(key);

  console.log('\nAUTH_APPLE_ID=' + servicesId);
  console.log('AUTH_APPLE_SECRET=' + secret);
  console.log(
    `\nExpires ${new Date(exp * 1000).toISOString()} — put a reminder in the calendar now.\n`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
