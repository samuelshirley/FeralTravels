import { expect, request, type APIRequestContext, type APIResponse } from '@playwright/test';
import { FIXTURE_TRIP_NAME, FIXTURE_USER_NAME, FIXTURE_VEHICLE_NAME, testEndpointHeaders } from './constants';
import { uniqueEmail } from './auth';

/**
 * HTTP-only helpers for the API contract specs: sign in the way the PHONE
 * does, and talk to the API with a bearer token.
 *
 * Sign-in is the real mobile OTP flow, end to end — `POST /api/mobile/otp/send`
 * stores a real code with its real expiry, `/api/test/otp` reads it back in
 * place of the mailbox (the same three guards as every fixture route), and
 * `POST /api/mobile/otp/verify` checks it with the real attempt limit and mints
 * a real `sessions` row. Nothing is minted on the side and nothing granted.
 *
 * Every context here carries the test secret header (testEndpointHeaders), so
 * the per-IP limits treat the run as the test runner (decision I7) and one
 * runner signing in dozens of accounts is not refused. The ONE request that
 * must not carry it builds its own context — see money-limits.spec.ts.
 */

export function targetBaseUrl(): string {
  return process.env.E2E_BASE_URL || `http://localhost:${process.env.E2E_PORT || 4444}`;
}

/** A context with no session at all: what an anonymous caller sends. */
export async function anonymousContext(): Promise<APIRequestContext> {
  return request.newContext({ baseURL: targetBaseUrl(), extraHTTPHeaders: testEndpointHeaders() });
}

/** POST a fixture route, failing loudly on anything but 2xx. */
export async function fixturePost<T>(path: string, data: Record<string, unknown>): Promise<T> {
  const ctx = await anonymousContext();
  try {
    const res = await ctx.post(path, { data });
    if (!res.ok()) throw new Error(`[e2e/api] ${path} failed (${res.status()}): ${await res.text()}`);
    return (await res.json()) as T;
  } finally {
    await ctx.dispose();
  }
}

export interface SeededAccount {
  email: string;
  userId: string;
  vehicleId: string;
  tripId: string;
}

/** Seed the canonical fixture graph for a fresh fixture address. */
export async function seedAccount(opts: Record<string, unknown> = {}): Promise<SeededAccount> {
  const email = (opts.email as string | undefined) ?? uniqueEmail();
  const seeded = await fixturePost<{ userId: string; vehicleId: string; tripId: string }>('/api/test/seed', {
    email,
    userName: FIXTURE_USER_NAME,
    vehicleName: FIXTURE_VEHICLE_NAME,
    tripName: FIXTURE_TRIP_NAME,
    ...opts,
  });
  return { email, ...seeded };
}

/** Read the pending code for a fixture address, polling until it lands. */
export async function readOtp(email: string): Promise<string> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const { code } = await fixturePost<{ code: string | null }>('/api/test/otp', { email });
    if (code) return code;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`[e2e/api] no OTP stored for ${email}`);
}

/** The real mobile sign-in. Returns the session token. */
export async function signInWithOtp(email: string): Promise<string> {
  const anon = await anonymousContext();
  try {
    const sent = await anon.post('/api/mobile/otp/send', { data: { email } });
    expect(sent.status(), `otp/send for ${email}: ${await sent.text()}`).toBe(200);
    const code = await readOtp(email);
    const verified = await anon.post('/api/mobile/otp/verify', { data: { email, code } });
    expect(verified.status(), `otp/verify for ${email}: ${await verified.text()}`).toBe(200);
    const { token } = (await verified.json()) as { token: string };
    expect(token).toBeTruthy();
    return token;
  } finally {
    await anon.dispose();
  }
}

/** A context that speaks as `token`, exactly as the iOS app does. */
export async function bearerContext(token: string): Promise<APIRequestContext> {
  return request.newContext({
    baseURL: targetBaseUrl(),
    extraHTTPHeaders: { ...testEndpointHeaders(), Authorization: `Bearer ${token}` },
  });
}

export interface SignedInAccount extends SeededAccount {
  api: APIRequestContext;
  legIds: string[];
}

/** Seed, sign in through OTP, and read back the seeded trip's leg ids. */
export async function signedInAccount(seed: Record<string, unknown> = {}): Promise<SignedInAccount> {
  const account = await seedAccount(seed);
  const api = await bearerContext(await signInWithOtp(account.email));
  const trip = await api.get(`/api/trip?tripId=${account.tripId}`);
  expect(trip.status(), await trip.text()).toBe(200);
  const body = (await trip.json()) as { legs?: { id: string }[] };
  const legIds = (body.legs ?? []).map((l) => l.id);
  expect(legIds.length, 'the canonical fixture has legs').toBeGreaterThan(0);
  return { ...account, api, legIds };
}

/** Paid calls (Anthropic, Google, gate classifier, Jev) on record for a fixture account. */
export async function paidUsage(email: string): Promise<{ calls: number; microcents: number }> {
  return fixturePost('/api/test/seed', { action: 'paid-usage', email });
}

/** Send a request described as data; used by the table-driven specs. */
export async function send(
  ctx: APIRequestContext,
  method: string,
  path: string,
  body?: unknown,
): Promise<APIResponse> {
  const opts = body === undefined ? {} : { data: body };
  switch (method) {
    case 'GET':
      return ctx.get(path);
    case 'POST':
      return ctx.post(path, opts);
    case 'PATCH':
      return ctx.patch(path, opts);
    case 'PUT':
      return ctx.put(path, opts);
    case 'DELETE':
      return ctx.delete(path, opts);
    default:
      throw new Error(`[e2e/api] unsupported method ${method}`);
  }
}
