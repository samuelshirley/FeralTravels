import { createHash } from 'node:crypto';

/**
 * "Is this production?" — asked by code that must never run there.
 *
 * Two independent signals, either of which is enough:
 *
 *  1. `VERCEL_ENV === 'production'` — the deployed production server. Set by
 *     Vercel at build AND runtime, and never on a preview or a laptop. (Not
 *     `NODE_ENV`: every `next build` runs with NODE_ENV=production, including
 *     CI's preview build and a local one, so it cannot tell prod apart.)
 *  2. `DATABASE_URL` pointing at the production Neon endpoint — which is what
 *     a laptop script has, because `.env` on the owner's machine IS production.
 *     `VERCEL_ENV` is unset there, so (1) alone would wave the script through.
 *
 * Deliberately NOT `server-only`: the scripts in scripts/ import it too, and
 * that marker throws outside a React server bundle.
 *
 * ── Why a hash, not the hostname ───────────────────────────────────────────
 *
 * This repository is public. A Neon endpoint id is not a credential, but it is
 * the production database's address, and there is no reason to publish it. The
 * SHA-256 of the endpoint id (`ep-…`, with Neon's `-pooler` suffix stripped so
 * the pooled and direct hosts compare equal) identifies it just as well.
 * Preview databases are Neon BRANCHES, which get their own endpoint ids, so a
 * copy of production data on a preview is correctly NOT production.
 *
 * If the production database ever moves to a new endpoint, update the hash:
 *   node -e "const id=new URL(process.env.DATABASE_URL).hostname.split('.')[0]
 *            .replace(/-pooler$/,''); console.log(require('crypto')
 *            .createHash('sha256').update(id).digest('hex'))"
 * Until then the DATABASE_URL half fails OPEN for the new endpoint — the
 * VERCEL_ENV half still holds for the deployed server.
 */
export const PRODUCTION_DB_ENDPOINT_SHA256 =
  '127c186513078a065d1f5c03efd41b0f03f9b2e84c3b4a3469679e268be76255';

type EnvLike = Record<string, string | undefined>;

/** The Neon endpoint id of a connection string, or null if it is not Neon-shaped. */
export function neonEndpointId(databaseUrl: string | undefined): string | null {
  if (!databaseUrl) return null;
  let host: string;
  try {
    host = new URL(databaseUrl).hostname;
  } catch {
    return null;
  }
  const first = host.split('.')[0] ?? '';
  if (!first.startsWith('ep-')) return null;
  return first.replace(/-pooler$/, '');
}

export function isProductionDatabaseUrl(
  databaseUrl: string | undefined,
  productionHash: string = PRODUCTION_DB_ENDPOINT_SHA256
): boolean {
  const id = neonEndpointId(databaseUrl);
  if (!id) return false;
  return createHash('sha256').update(id).digest('hex') === productionHash;
}

export function isProductionEnvironment(env: EnvLike = process.env): boolean {
  return env.VERCEL_ENV === 'production' || isProductionDatabaseUrl(env.DATABASE_URL);
}

export class RefusedInProductionError extends Error {
  constructor(what: string) {
    super(
      `${what} refuses to run in production (VERCEL_ENV=production, or DATABASE_URL is the ` +
        'production database). See src/server/productionGuard.ts.'
    );
  }
}

/** Throw if this process is production. Call it at MODULE LOAD, not per request. */
export function assertNotProduction(what: string, env: EnvLike = process.env): void {
  if (isProductionEnvironment(env)) throw new RefusedInProductionError(what);
}

/* ── The one sanctioned way past it: scripts/db-reset.ts ───────────────────
 *
 * Dropping every table must be possible on production exactly once when the
 * owner means it (the 2026-09-21 wipe) and never by accident afterwards. So the
 * override is AWKWARD and SINGLE-USE by construction:
 *
 *   --i-understand-this-wipes-production=<endpoint-id>:<challenge>
 *
 *  - `<endpoint-id>` is the production Neon endpoint (`ep-…`). It is not in
 *    this repo and the refusal does not print it: you type it from .env.
 *  - `<challenge>` is printed by a refused run. It hashes the endpoint, the
 *    UTC date and a fingerprint of the database's CURRENT contents (its tables
 *    and its `users` rows), so it expires at midnight UTC and stops matching
 *    the moment the wipe it authorised has run. A flag in shell history
 *    cannot be replayed.
 */
export const WIPE_OVERRIDE_FLAG = '--i-understand-this-wipes-production';

export function wipeChallenge(endpointId: string, utcDate: string, fingerprint: string): string {
  return createHash('sha256')
    .update(`${endpointId}|${utcDate}|${fingerprint}`)
    .digest('hex')
    .slice(0, 12);
}

/** The value of the override flag, or null. Only the `=` form; no env var equivalent. */
export function wipeOverrideFrom(argv: string[]): string | null {
  const hit = argv.find((a) => a.startsWith(`${WIPE_OVERRIDE_FLAG}=`));
  return hit ? hit.slice(WIPE_OVERRIDE_FLAG.length + 1) : null;
}

export function wipeOverrideValid(
  override: string | null,
  databaseUrl: string | undefined,
  utcDate: string,
  fingerprint: string
): boolean {
  if (!override) return false;
  const endpointId = neonEndpointId(databaseUrl);
  if (!endpointId) return false;
  const [typedEndpoint, typedChallenge] = override.split(':');
  return (
    typedEndpoint === endpointId &&
    typedChallenge === wipeChallenge(endpointId, utcDate, fingerprint)
  );
}
