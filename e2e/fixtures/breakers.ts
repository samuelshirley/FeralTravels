import { request, type APIRequestContext } from '@playwright/test';
import { testEndpointHeaders } from './constants';

/**
 * Driving `/api/test/breakers` — the fixture endpoint that puts the global
 * circuit breakers into a known state.
 *
 * Same shape as `subscription.ts`: a standalone request context against the
 * guarded endpoint, no raw SQL in a spec and no session involved.
 */
function targetBaseUrl(): string {
  return process.env.E2E_BASE_URL || `http://localhost:${process.env.E2E_PORT || 4444}`;
}

async function withApi<T>(fn: (ctx: APIRequestContext) => Promise<T>): Promise<T> {
  const ctx = await request.newContext({
    baseURL: targetBaseUrl(),
    extraHTTPHeaders: testEndpointHeaders(),
  });
  try {
    return await fn(ctx);
  } finally {
    await ctx.dispose();
  }
}

async function post<T>(data: Record<string, unknown>): Promise<T> {
  return withApi(async (ctx) => {
    const res = await ctx.post('/api/test/breakers', { data });
    if (!res.ok()) {
      throw new Error(`[e2e/breakers] ${data.action} failed (${res.status()}): ${await res.text()}`);
    }
    return (await res.json()) as T;
  });
}

export interface BreakerState {
  worst: 'ok' | 'alert' | 'open';
  locked: boolean;
  statuses: Array<{ id: string; level: string; value: number; stopAt: number | null }>;
}

/** Add to the app's GLOBAL 24-hour Anthropic total. `$1 = 1e8` microcents. */
export async function seedGlobalSpend(email: string, microcents: number): Promise<void> {
  await post({ action: 'seed-spend', email, microcents });
}

/** Remove every synthetic breaker row. Safe to call when there are none. */
export async function clearGlobalSpend(): Promise<void> {
  await post({ action: 'clear-spend' });
}

/** Throw or clear the manual Penny lock. */
export async function setPennyLock(locked: boolean): Promise<void> {
  await post({ action: 'set-lock', locked });
}

/** The breakers as the server sees them right now, read fresh. */
export async function readBreakerState(): Promise<BreakerState> {
  return post<BreakerState>({ action: 'state' });
}

export function levelOf(state: BreakerState, id: string): string | undefined {
  return state.statuses.find((s) => s.id === id)?.level;
}
