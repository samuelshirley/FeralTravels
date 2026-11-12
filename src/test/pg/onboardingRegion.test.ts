import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The first onboarding question shows examples for the requester's region:
 * a US or Canadian user sees "Denver to Moab", everyone else "Paris to
 * Stuttgart". The region comes from Vercel's `x-vercel-ip-country` on the
 * request, so ONE server decision reaches web and iOS alike.
 *
 * Through the real GET route and real repos against Postgres; only auth is
 * mocked (Auth.js cannot boot here).
 */

const m = vi.hoisted(() => ({ userId: '' }));

vi.mock('server-only', () => ({}));
vi.mock('@/server/db/client', async () => (await import('./harness')).clientModule());
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('@/server/auth/index', () => ({ auth: vi.fn() }));
vi.mock('@/server/auth/guards', async (orig) => ({
  ...(await orig<typeof import('@/server/auth/guards')>()),
  requireUserId: vi.fn(async () => m.userId),
}));

import { eq } from 'drizzle-orm';
import { trips } from '@/server/db/schema';
import { createTrip } from '@/server/repos/trips';
import { CITY_HINT_BY_REGION, TRIP_INTENT_PROMPTS_BY_REGION } from '@/lib/onboardingForm';
import { GET as onboardingGET } from '@/app/api/trips/[id]/onboarding/route';
import { resetDb, seedUser, testDb } from './harness';

beforeEach(async () => {
  await resetDb();
  vi.clearAllMocks();
});

async function tripAtFirstQuestion(): Promise<string> {
  const user = await seedUser();
  const trip = await createTrip({ userId: user.id, name: `Region ${crypto.randomUUID().slice(0, 8)}` });
  const { db } = await testDb();
  await db.update(trips).set({ onboardingState: 'trip_intent' }).where(eq(trips.id, trip.id));
  m.userId = user.id;
  return trip.id;
}

async function firstQuestion(country: string | null) {
  const tripId = await tripAtFirstQuestion();
  const headers = new Headers();
  if (country !== null) headers.set('x-vercel-ip-country', country);
  const res = await onboardingGET(new Request(`https://example.test/api/trips/${tripId}/onboarding`, { headers }), {
    params: { id: tripId },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { question: { key: string; prompts?: string[]; cityHint?: string } };
  expect(body.question.key).toBe('trip_intent');
  return body.question;
}

describe('first onboarding question — regional examples', () => {
  it.each(['US', 'CA', 'us'])('%s gets the North American prompts and city hint', async (country) => {
    const q = await firstQuestion(country);
    expect(q.prompts).toEqual([...TRIP_INTENT_PROMPTS_BY_REGION.north_america]);
    expect(q.cityHint).toBe(CITY_HINT_BY_REGION.north_america);
  });

  it.each(['ES', 'DE', 'GB'])('%s gets the European prompts and city hint', async (country) => {
    const q = await firstQuestion(country);
    expect(q.prompts).toEqual([...TRIP_INTENT_PROMPTS_BY_REGION.europe]);
    expect(q.cityHint).toBe(CITY_HINT_BY_REGION.europe);
  });

  it('no country header (local dev) is Europe, as before', async () => {
    const q = await firstQuestion(null);
    expect(q.prompts).toEqual([...TRIP_INTENT_PROMPTS_BY_REGION.europe]);
    expect(q.cityHint).toBe(CITY_HINT_BY_REGION.europe);
  });
});
