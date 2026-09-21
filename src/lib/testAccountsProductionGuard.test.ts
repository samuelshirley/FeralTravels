/**
 * Decision E13 (and E6): after the 2026-09-21 production wipe, every row in
 * production is real — so nothing that writes a fake subscription may run
 * there, and the fake purchase must not exist at all.
 *
 * Four halves, all structural:
 *
 *  1. `productionGuard.ts` recognises production by EITHER signal.
 *  2. `payments/testAccounts.ts` throws AT IMPORT in production. Not per call:
 *     a call-site check is one forgotten line from writing `source: 'fake'`
 *     rows into a real database; a module that will not load has no call
 *     sites. Remove the `assertNotProduction(...)` line and this goes red.
 *  3. Production code reaches it only by `await import()` behind
 *     `testAccountsAvailable()`, so `/admin` still renders in production
 *     instead of 500ing on a static import of a module that refuses to load.
 *  4. The fake purchase is gone: no route, no caller, no payload field.
 *  5. `scripts/db-reset.ts` asks the same question before it drops anything,
 *     and its override is single-use (bound to the date and the data).
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isProductionDatabaseUrl,
  isProductionEnvironment,
  neonEndpointId,
  wipeChallenge,
  wipeOverrideFrom,
  wipeOverrideValid,
  WIPE_OVERRIDE_FLAG,
} from '@/server/productionGuard';
import { testAccountsAvailable } from '@/server/payments/testAccountGate';

vi.mock('server-only', () => ({}));
// Same three mocks as testAccounts.test.ts: the module reaches the database and
// Auth.js at import time, and none of that is what is under test here.
vi.mock('@/server/db/client', () => ({ db: {} }));
vi.mock('@/server/repos/trips', () => ({ cloneTrip: vi.fn(), createTrip: vi.fn() }));
vi.mock('@/server/repos/vehicles', () => ({ addVehicle: vi.fn() }));

const ROOT = process.cwd();
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const NEON = (endpoint: string) =>
  `postgres://u:p@${endpoint}.c-5.us-east-1.aws.neon.tech/neondb?sslmode=require`;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('productionGuard knows production by either signal', () => {
  it('VERCEL_ENV=production is production; preview and unset are not', () => {
    expect(isProductionEnvironment({ VERCEL_ENV: 'production' })).toBe(true);
    expect(isProductionEnvironment({ VERCEL_ENV: 'preview' })).toBe(false);
    expect(isProductionEnvironment({})).toBe(false);
  });

  it('matches the production endpoint by hash, pooled or direct, and nothing else', () => {
    const hash = sha('ep-example-prod-123');
    expect(isProductionDatabaseUrl(NEON('ep-example-prod-123'), hash)).toBe(true);
    expect(isProductionDatabaseUrl(NEON('ep-example-prod-123-pooler'), hash)).toBe(true);
    // A preview is a Neon BRANCH, with its own endpoint id — a copy of prod's
    // data is not prod.
    expect(isProductionDatabaseUrl(NEON('ep-example-branch-456'), hash)).toBe(false);
    expect(isProductionDatabaseUrl('postgres://feral:feral@127.0.0.1:55432/e2e', hash)).toBe(false);
    expect(isProductionDatabaseUrl('not a url', hash)).toBe(false);
    expect(isProductionDatabaseUrl(undefined, hash)).toBe(false);
  });

  it('extracts the endpoint id the hash is taken over', () => {
    expect(neonEndpointId(NEON('ep-a-b-c-pooler'))).toBe('ep-a-b-c');
    expect(neonEndpointId('postgres://x@localhost/db')).toBeNull();
  });

  it('the generator is unavailable in production even with SUBSCRIPTION_TESTING=1', () => {
    expect(testAccountsAvailable({ SUBSCRIPTION_TESTING: '1', VERCEL_ENV: 'production' })).toBe(false);
    expect(testAccountsAvailable({ SUBSCRIPTION_TESTING: '1', VERCEL_ENV: 'preview' })).toBe(true);
    expect(testAccountsAvailable({ VERCEL_ENV: 'preview' })).toBe(false);
  });
});

describe('payments/testAccounts.ts refuses to load in production', () => {
  it('throws at import when VERCEL_ENV=production', async () => {
    vi.stubEnv('VERCEL_ENV', 'production');
    // By message, not `instanceof`: resetModules gives the dynamic import its
    // own copy of productionGuard, so the class identity differs.
    await expect(import('@/server/payments/testAccounts')).rejects.toThrow(
      /test-account generator.*refuses to run in production/
    );
  });

  it('loads normally anywhere else (a preview, CI, a laptop on a local database)', async () => {
    vi.stubEnv('VERCEL_ENV', 'preview');
    vi.stubEnv('DATABASE_URL', 'postgres://feral:feral@127.0.0.1:55432/feraltravels_e2e');
    const mod = await import('@/server/payments/testAccounts');
    expect(typeof mod.createTestAccount).toBe('function');
  });
});

/** Every .ts/.tsx under a directory, skipping build output and dependencies. */
function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'shared' || name === 'ios' || name.startsWith('.')) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) sources(full, out);
    else if (/\.(ts|tsx|mjs|js)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

/** Crude but sufficient: drop block and line comments, so a tombstone comment is allowed. */
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const rel = (f: string) => path.relative(ROOT, f);
const APP_CODE = [...sources(path.join(ROOT, 'src')), ...sources(path.join(ROOT, 'mobile'))];

describe('production code never imports the generator statically', () => {
  it('no static import of payments/testAccounts anywhere in src/ or mobile/', () => {
    const hits = APP_CODE.filter((f) => rel(f) !== 'src/server/payments/testAccounts.ts').filter((f) =>
      /^\s*(import|export)\s[^;]*?from\s*['"][^'"]*payments\/testAccounts['"]/m.test(code(f))
    );
    expect(hits, 'use testAccountsAvailable() + await import() — see decision E13').toEqual([]);
  });

  it('the one dynamic import is behind testAccountsAvailable()', () => {
    const dynamic = APP_CODE.filter((f) =>
      /import\(\s*['"][^'"]*payments\/testAccounts['"]\s*\)/.test(code(f))
    ).map(rel);
    expect(dynamic).toEqual(['src/app/api/admin/test-users/route.ts']);
    const route = code(path.join(ROOT, dynamic[0]));
    // Both handlers gate before they load it.
    expect(route.match(/if \(!testAccountsAvailable\(\)\) return notHere\(\);/g)).toHaveLength(2);
  });
});

describe('the fake purchase is gone', () => {
  it('has no route', () => {
    expect(existsSync(path.join(ROOT, 'src/app/api/purchase/test/route.ts'))).toBe(false);
    expect(existsSync(path.join(ROOT, 'src/server/payments/testPurchase.ts'))).toBe(false);
  });

  it('has no caller and no payload field, in the web app or the iOS app', () => {
    const hits: string[] = [];
    for (const f of APP_CODE) {
      const src = code(f);
      if (/['"]\/api\/purchase\/test['"]/.test(src)) hits.push(`${rel(f)}: calls /api/purchase/test`);
      if (/\btestPurchaseAllowed\b|\bisTestPurchaseAllowed\b|\btestPurchase\s*\(/.test(src)) {
        hits.push(`${rel(f)}: fake-purchase identifier`);
      }
    }
    expect(hits).toEqual([]);
  });
});

describe('scripts/db-reset.ts refuses production without a single-use override', () => {
  const URL = NEON('ep-example-prod-123-pooler');
  const FP = 'trips,users|2:abc';
  const DAY = '2026-09-21';
  const good = `ep-example-prod-123:${wipeChallenge('ep-example-prod-123', DAY, FP)}`;

  it('accepts only the endpoint id AND the challenge for today and this data', () => {
    expect(wipeOverrideValid(good, URL, DAY, FP)).toBe(true);
    expect(wipeOverrideValid(null, URL, DAY, FP)).toBe(false);
    expect(wipeOverrideValid(`ep-other:${good.split(':')[1]}`, URL, DAY, FP)).toBe(false);
    // Tomorrow, or after the wipe changed the data, the same flag is dead.
    expect(wipeOverrideValid(good, URL, '2026-09-22', FP)).toBe(false);
    expect(wipeOverrideValid(good, URL, DAY, '|no-users-table')).toBe(false);
  });

  it('reads the override only from its exact `--flag=value` form', () => {
    expect(wipeOverrideFrom([`${WIPE_OVERRIDE_FLAG}=x:y`])).toBe('x:y');
    expect(wipeOverrideFrom([WIPE_OVERRIDE_FLAG, 'x:y'])).toBeNull();
    expect(wipeOverrideFrom(['--force'])).toBeNull();
  });

  it('checks production and the override BEFORE the first DROP', () => {
    const src = code(path.join(ROOT, 'scripts/db-reset.ts'));
    const check = src.indexOf('isProductionDatabaseUrl(process.env.DATABASE_URL)');
    const valid = src.indexOf('wipeOverrideValid(');
    const drop = src.indexOf('DROP TABLE');
    expect(check).toBeGreaterThan(-1);
    expect(valid).toBeGreaterThan(check);
    expect(drop).toBeGreaterThan(valid);
  });
});
