/**
 * The native screens draw from the resource cache, and the cache never
 * outlives the account that filled it.
 *
 * The incident (screen recording, iPhone, 2026-10-22): every screen held its
 * server data in `useState`, which starts empty on every mount, so every
 * navigation was a spinner. The cure is shared/lib/resourceCache.ts; this
 * keeps the screens on it and keeps its account boundary intact.
 *
 * Read as TEXT, never imported (noMobileImportGuard.test.ts).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (rel: string) => readFileSync(path.join(process.cwd(), rel), 'utf8');

describe('screens render from the cache, not from empty screen state', () => {
  it.each([
    ['mobile/app/trips/[tripId].tsx', /useState<(Trip|LegWithDetails\[\]|POI\[\]|EntitlementPayload)\b/],
    ['mobile/app/trips/index.tsx', /useState<(Trip\[\]|EntitlementPayload|MeWithId)\b/],
    ['mobile/app/settings.tsx', /useState<Me\b/],
    ['mobile/components/VehicleProfileSection.tsx', /useState<Vehicle\[\]/],
    ['mobile/components/SubscriptionSection.tsx', /useState<EntitlementPayload/],
    ['mobile/components/TripHeader.tsx', /useState<(Vehicle\[\]|Me)\b/],
  ])('%s holds no server data in useState', (file, pattern) => {
    expect(read(file)).not.toMatch(pattern);
  });

  it('the trip workspace reads the trip and its POIs from the cache', () => {
    const src = read('mobile/app/trips/[tripId].tsx');
    expect(src).toMatch(/useCached<[^>]+>\(cacheKeys\.trip\(tripId\)\)/);
    expect(src).toMatch(/useCached<POI\[\]>\(cacheKeys\.pois\(tripId\)\)/);
    // "Loading trip" only for a trip this phone has never had.
    expect(src).toMatch(/const loading = !cachedTrip && !settled;/);
  });

  it('the trips list reads the list from the cache', () => {
    expect(read('mobile/app/trips/index.tsx')).toMatch(/useCached<Trip\[\]>\(cacheKeys\.trips\)/);
  });
});

describe('the cache never outlives the account that filled it', () => {
  const auth = read('mobile/lib/auth.ts');
  const fnBody = (name: string) =>
    auth.match(new RegExp(`export async function ${name}\\([^)]*\\)[^{]*\\{([\\s\\S]*?)\\n\\}`))?.[1] ?? '';

  it('sign-out (and every 401, and account deletion, which all go through clearToken) empties it', () => {
    expect(fnBody('clearToken')).toMatch(/resetResourceCache\(\)/);
  });

  it('sign-in empties it before the new token is stored', () => {
    const body = fnBody('setToken');
    expect(body).toMatch(/resetResourceCache\(\);[\s\S]*SecureStore\.setItemAsync\(TOKEN_KEY/);
  });

  it('every sign-out path goes through clearToken', () => {
    // A path that removed the token another way would skip the reset.
    for (const f of [
      'mobile/lib/api.ts',
      'mobile/app/trips/index.tsx',
      'mobile/components/TripHeader.tsx',
      'mobile/components/DeleteAccountSection.tsx',
    ]) {
      expect(read(f), f).not.toMatch(/deleteItemAsync\(/);
    }
  });
});

describe('disk', () => {
  const cache = read('mobile/lib/cache.ts');

  it('is loaded at module scope in the root layout, before any screen reads', () => {
    expect(read('mobile/app/_layout.tsx')).toMatch(/^configureResourceCache\(\);$/m);
  });

  it('lives in the caches directory: purgeable, and outside device backups', () => {
    expect(cache).toMatch(/new File\(Paths\.cache, FILE_NAME\)/);
    expect(cache).not.toMatch(/Paths\.document/);
  });

  it('is read synchronously, so the first frame of a cold launch already has it', () => {
    expect(cache).toMatch(/textSync\(\)/);
  });

  it('expo-file-system is declared, not borrowed from expo’s own node_modules', () => {
    const pkg = JSON.parse(read('mobile/package.json')) as { dependencies: Record<string, string> };
    expect(pkg.dependencies['expo-file-system']).toBeDefined();
  });
});
