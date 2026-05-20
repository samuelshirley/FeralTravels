/**
 * HTTP smoke checks for deploy confidence.
 *
 * Usage:
 *   1. Start the app: `npm run build && PORT=3010 npm start`
 *   2. Run: `SMOKE_BASE_URL=http://127.0.0.1:3010 npx tsx scripts/smoke-api.ts`
 *
 * Authenticated checks (optional):
 *   Copy the Cookie header from DevTools → Application → Cookies (after sign-in).
 *   SMOKE_COOKIE='authjs.session-token=...' SMOKE_TRIP_ID=<uuid> npx tsx scripts/smoke-api.ts
 *
 * Vehicle remediation snapshot (optional, same cookie):
 *   Printed automatically when SMOKE_COOKIE is set — `GET /api/me/vehicle-remediation` body (full JSON).
 *
 * Strict auth UI (optional): fail if /api/auth/providers is not 200
 *   SMOKE_STRICT_AUTH=1 npx tsx scripts/smoke-api.ts
 */

const base = (process.env.SMOKE_BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const cookie = process.env.SMOKE_COOKIE?.trim();
const tripId = process.env.SMOKE_TRIP_ID?.trim();
const strictAuth = process.env.SMOKE_STRICT_AUTH === '1';

let failed = false;

function fail(msg: string) {
  console.error('FAIL:', msg);
  failed = true;
}

function pass(msg: string) {
  console.log('OK', msg);
}

function warn(msg: string) {
  console.warn('WARN:', msg);
}

async function main() {
  // --- App shell ---
  const loginRes = await fetch(`${base}/login`, { redirect: 'manual' });
  if (loginRes.status !== 200) {
    fail(`/login expected 200, got ${loginRes.status}`);
  } else {
    const html = await loginRes.text();
    if (!html.includes('html') && !html.includes('DOCTYPE')) {
      fail('/login body does not look like HTML');
    } else {
      pass('/login (200, HTML document)');
    }
  }

  // --- Auth discovery (needs valid AUTH_* / providers in production) ---
  const providersRes = await fetch(`${base}/api/auth/providers`, { redirect: 'manual' });
  if (providersRes.status === 200) {
    const body = await providersRes.json();
    if (typeof body !== 'object' || body == null) {
      fail('/api/auth/providers body is not an object');
    } else {
      pass(`/api/auth/providers (${Object.keys(body as object).length} keys)`);
    }
  } else if (strictAuth) {
    fail(`/api/auth/providers expected 200 with SMOKE_STRICT_AUTH=1, got ${providersRes.status}`);
  } else {
    warn(
      `/api/auth/providers got ${providersRes.status} (local auth often needs AUTH_URL / provider secrets; set SMOKE_STRICT_AUTH=1 on prod-like env)`
    );
  }

  // --- Protected JSON API: no session must not return a full trip list ---
  const tripsNoCookie = await fetch(`${base}/api/trips`, { redirect: 'manual' });
  const blocked =
    tripsNoCookie.status === 401 ||
    tripsNoCookie.status === 403 ||
    [302, 307, 308].includes(tripsNoCookie.status);
  if (!blocked) {
    fail(
      `/api/trips without cookie expected 401/403 or redirect, got ${tripsNoCookie.status}`
    );
  } else if (tripsNoCookie.status === 401) {
    const j = await tripsNoCookie.json().catch(() => null);
    if (j && typeof j === 'object' && 'error' in j) {
      pass('/api/trips without cookie → 401 JSON (Unauthorized)');
    } else {
      pass(`/api/trips without cookie → ${tripsNoCookie.status}`);
    }
  } else {
    const loc = tripsNoCookie.headers.get('location') || '';
    if (!loc.includes('/login')) {
      fail(`/api/trips redirect should target /login, got ${loc}`);
    } else {
      pass(`/api/trips without cookie → redirect to login (${tripsNoCookie.status})`);
    }
  }

  if (!cookie) {
    console.log('\nSkip authenticated checks (set SMOKE_COOKIE and optionally SMOKE_TRIP_ID).');
  } else {
    const headers = { Cookie: cookie, Accept: 'application/json' };

    const tripsRes = await fetch(`${base}/api/trips`, { headers });
    if (tripsRes.status !== 200) {
      fail(`/api/trips with cookie expected 200, got ${tripsRes.status} ${(await tripsRes.text()).slice(0, 400)}`);
    } else {
      const trips = await tripsRes.json();
      if (!Array.isArray(trips)) {
        fail('/api/trips body should be an array');
      } else {
        pass(`/api/trips (${trips.length} trips)`);
      }
    }

    const dUrl = new URL(`${base}/api/directions`);
    dUrl.searchParams.set('startLat', '41.979');
    dUrl.searchParams.set('startLng', '2.821');
    dUrl.searchParams.set('endLat', '52.52');
    dUrl.searchParams.set('endLng', '13.405');
    const dirRes = await fetch(dUrl.toString(), { headers });
    if (dirRes.status !== 200) {
      fail(
        `/api/directions expected 200: ${dirRes.status} ${(await dirRes.text()).slice(0, 200)}`
      );
    } else {
      const d = (await dirRes.json()) as Record<string, unknown>;
      const hasKm = typeof d.distance_km === 'number';
      const hasGeom = typeof d.geometry === 'string';
      if (!hasKm || !hasGeom) {
        fail(
          `/api/directions expected distance_km (number) and geometry (string); got keys: ${Object.keys(d).join(', ')}`
        );
      } else {
        pass(
          `/api/directions (${d.distance_km} km, ${(d.geometry as string).length > 0 ? 'polyline ok' : 'empty geom'})`
        );
      }
    }

    const remediationRes = await fetch(`${base}/api/me/vehicle-remediation`, { headers });
    if (remediationRes.status !== 200) {
      fail(
        `/api/me/vehicle-remediation expected 200, got ${remediationRes.status} ${(await remediationRes.text()).slice(0, 400)}`
      );
    } else {
      const body = await remediationRes.text();
      try {
        const rem = JSON.parse(body) as Record<string, unknown>;
        pass(
          `/api/me/vehicle-remediation (copy for support): ${JSON.stringify(rem)}`
        );
      } catch {
        fail('/api/me/vehicle-remediation body is not JSON');
      }
    }

    if (tripId) {
      const tripRes = await fetch(`${base}/api/trip?tripId=${tripId}`, { headers });
      if (tripRes.status !== 200) {
        fail(
          `/api/trip?tripId= expected 200: ${tripRes.status} ${(await tripRes.text()).slice(0, 300)}`
        );
      } else {
        const trip = (await tripRes.json()) as { name?: string; legs?: unknown[] };
        if (!Array.isArray(trip.legs)) {
          fail('/api/trip body should include legs[]');
        } else {
          pass(`/api/trip?tripId=${tripId} (name=${String(trip.name)}, legs=${trip.legs.length})`);
        }
      }
    }
  }

  if (failed) {
    process.exit(1);
  }
  console.log('\nAll smoke checks passed.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
