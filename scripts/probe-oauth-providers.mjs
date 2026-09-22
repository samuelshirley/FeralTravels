#!/usr/bin/env node
// Probe the two things native OAuth sign-in depends on, and say whether either
// is broken. Run by .github/workflows/oauth-provider-probe.yml on a schedule;
// runnable by hand:
//
//   node scripts/probe-oauth-providers.mjs [--base https://www.feraltravels.com] [--json out.json]
//
// WHY. On 2026-09-21 Apple's https://appleid.apple.com/auth/keys answered 404
// to about one request in five, and real Sign in with Apple attempts failed in
// production for it. Nothing noticed: the e2e forged-token tests passed,
// because the server answered "could not fetch the keys" with the same 401
// InvalidToken it gives a forgery. This probe watches both halves from outside:
//
//  1. Each provider's JWKS endpoint, JWKS_PROBES times. A failure rate at or
//     over JWKS_ALERT_RATE alerts. Normal is zero.
//  2. The PRODUCTION exchange route, EXCHANGE_PROBES times, with a forged
//     Apple token. The only healthy answer is 401 InvalidToken. 503
//     ProviderUnavailable means production could not get Apple's keys even
//     with its retries and its persisted fallback, so real users are being
//     refused; 200 would mean it handed a session to a forgery.
//
// RATE LIMITS. A forged token fails signature verification before
// consumeIdToken() in oauthReplay.ts runs, so the per-address limiter (5 per
// minute) never counts these; the exchange is not behind any per-IP limiter
// (src/lib/ipLimit.ts has no scope for it). The spacing below is courtesy to
// production, not a limit being dodged.
//
// No dependencies (node:crypto signs the JWT), so the workflow needs no
// `npm ci`. Exits 0 whatever it finds — the verdict is in the output, so a
// broken provider files an issue rather than a red run nobody reads.
import { generateKeyPairSync, sign } from 'node:crypto';
import { appendFileSync, writeFileSync } from 'node:fs';

const PROVIDERS = {
  apple: 'https://appleid.apple.com/auth/keys',
  google: 'https://www.googleapis.com/oauth2/v3/certs',
};
const JWKS_PROBES = 30;
const JWKS_GAP_MS = 500;
/** 2 of 30. One miss in thirty is noise; two in one run is a pattern worth a look. */
const JWKS_ALERT_RATE = 0.05;
const EXCHANGE_PROBES = 5;
const EXCHANGE_GAP_MS = 3000;

const args = process.argv.slice(2);
const argValue = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const BASE = argValue('--base', 'https://www.feraltravels.com').replace(/\/$/, '');
const JSON_OUT = argValue('--json', null);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function probeJwks(url) {
  const tally = {};
  const kids = new Set();
  for (let i = 0; i < JWKS_PROBES; i++) {
    let outcome;
    try {
      const res = await fetch(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(5000),
      });
      outcome = String(res.status);
      if (res.status === 200) {
        const body = await res.json().catch(() => null);
        if (!Array.isArray(body?.keys) || body.keys.length === 0) outcome = '200-not-a-jwks';
        else for (const k of body.keys) if (typeof k.kid === 'string') kids.add(k.kid);
      } else {
        await res.body?.cancel();
      }
    } catch (err) {
      outcome = err?.name === 'TimeoutError' ? 'timeout' : `network-${err?.cause?.code ?? err?.name}`;
    }
    tally[outcome] = (tally[outcome] ?? 0) + 1;
    if (i < JWKS_PROBES - 1) await sleep(JWKS_GAP_MS);
  }
  const failures = JWKS_PROBES - (tally['200'] ?? 0);
  return { url, tally, failures, rate: failures / JWKS_PROBES, kids: [...kids] };
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');

/** A structurally perfect Apple ID token that Apple never signed. */
function forgeAppleToken(kid) {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' }));
  const payload = b64url(
    JSON.stringify({
      iss: 'https://appleid.apple.com',
      aud: 'com.feraltravels.ios',
      sub: 'oauth-provider-probe',
      // The e2e fixture subdomain: it has no MX record, so nothing can ever be
      // delivered to it even if something went badly wrong.
      email: 'oauth-probe@e2e.feraltravels.com',
      email_verified: true,
      iat: now,
      exp: now + 600,
    })
  );
  const signature = sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey);
  return `${header}.${payload}.${b64url(signature)}`;
}

async function probeExchange(kid) {
  const results = [];
  for (let i = 0; i < EXCHANGE_PROBES; i++) {
    let status;
    let code;
    try {
      const res = await fetch(`${BASE}/api/mobile/oauth/exchange`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'apple', idToken: forgeAppleToken(kid) }),
        signal: AbortSignal.timeout(30_000),
      });
      status = res.status;
      const body = await res.json().catch(() => null);
      code = typeof body?.error === 'string' ? body.error : body?.token ? 'SESSION-ISSUED' : '?';
    } catch (err) {
      status = 0;
      code = err?.name === 'TimeoutError' ? 'timeout' : `network-${err?.cause?.code ?? err?.name}`;
    }
    results.push({ status, code });
    if (i < EXCHANGE_PROBES - 1) await sleep(EXCHANGE_GAP_MS);
  }
  return results;
}

const startedAt = new Date().toISOString();
const jwks = {};
for (const [name, url] of Object.entries(PROVIDERS)) jwks[name] = await probeJwks(url);
// A kid Apple really publishes, so production takes the signature path rather
// than an unknown-kid rotation refresh. Only if Apple served no keys at all to
// thirty requests do we fall back to a made-up one.
const kid = jwks.apple.kids[0] ?? 'oauth-probe-unknown-kid';
const exchange = await probeExchange(kid);

const alerts = [];
for (const [name, r] of Object.entries(jwks)) {
  if (r.rate >= JWKS_ALERT_RATE) {
    alerts.push(
      `${name} JWKS failed ${r.failures}/${JWKS_PROBES} (${Math.round(r.rate * 100)}%): ${JSON.stringify(r.tally)}`
    );
  }
}
const bad = exchange.filter((r) => !(r.status === 401 && r.code === 'InvalidToken'));
if (bad.some((r) => r.status === 200 || r.code === 'SESSION-ISSUED')) {
  alerts.unshift('PRODUCTION ISSUED A SESSION FOR A FORGED APPLE TOKEN. Treat as a security incident.');
}
if (bad.some((r) => r.code === 'ProviderUnavailable')) {
  alerts.push(
    `production exchange answered 503 ProviderUnavailable to ${bad.filter((r) => r.code === 'ProviderUnavailable').length}/${EXCHANGE_PROBES} forged tokens: it could not get Apple's keys even with retries and its persisted fallback, so real Apple sign-ins are being refused. Search the Vercel logs for "ProviderUnavailable" for the upstream status.`
  );
}
const other = bad.filter((r) => r.code !== 'ProviderUnavailable' && r.status !== 200);
if (other.length > 0) {
  alerts.push(
    `production exchange gave ${other.length}/${EXCHANGE_PROBES} forged tokens something other than 401 InvalidToken: ${JSON.stringify(other)}`
  );
}

const summary = [
  `### OAuth provider probe — ${startedAt}`,
  '',
  alerts.length ? `**ALERT**\n\n${alerts.map((a) => `- ${a}`).join('\n')}` : '**Healthy.**',
  '',
  '| Check | Result |',
  '|---|---|',
  ...Object.entries(jwks).map(
    ([name, r]) => `| ${name} JWKS × ${JWKS_PROBES} | ${JSON.stringify(r.tally)} |`
  ),
  `| ${BASE} exchange, forged Apple token × ${EXCHANGE_PROBES} | ${exchange.map((r) => `${r.status} ${r.code}`).join(', ')} |`,
  '',
].join('\n');

console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + '\n');
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `alert=${alerts.length > 0}\n`);
}
if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify({ startedAt, alerts, jwks, exchange, summary }, null, 2));
