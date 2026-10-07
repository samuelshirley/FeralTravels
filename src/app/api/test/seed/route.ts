import { z } from 'zod';
import { isTestRequestAuthorized } from '@/server/auth/test-endpoints';
import { JEV_MODES } from '@/server/repos/jev';
import { readFixturePaidUsage, seedFixture } from '@/server/repos/testSupport';

/**
 * TEST-ONLY: reset a persona's graph and recreate the canonical fixture
 * (default vehicle + trip + two legs). 404 unless test endpoints are enabled.
 */
const bodySchema = z.object({
  email: z.string().email(),
  userName: z.string().optional(),
  vehicleName: z.string().min(1),
  tripName: z.string().min(1),
  /** Optional fixture vehicle range. Defaults to the Hilux's real 500 km. */
  rangeKm: z.number().int().min(50).max(2000).optional(),
  /** Which itinerary to seed. Defaults to the canonical two legs. */
  legPreset: z.enum(['canonical', 'three_long_drives']).optional(),
  /** Put one forced Finn fuel stop on day 1, its fuel cache fresh. Default off. */
  forcedFuelStop: z.boolean().optional(),
  /** Force this fixture account's Jev mode (users.jev_mode). Default: left as is. */
  jevMode: z.enum(JEV_MODES).optional(),
  /**
   * Write the columns no affordable flow leaves on a preview (stop
   * alternatives, a leg's continuity warning, a failed turn with an image…),
   * for the column-coverage measurement. Fixture addresses only. Default off.
   */
  coverageColumns: z.boolean().optional(),
  /** Plant this many $0 Penny requests in the last hour (replan's hourly cap). */
  replanRequestsLastHour: z.number().int().min(1).max(1000).optional(),
});

/**
 * `action: 'paid-usage'` READS instead: how many paid calls (Anthropic, Google,
 * the gate classifier, Jev) are on record for a fixture account. The contract
 * specs compare it before and after a refusal, to prove the refusal came
 * before any spend. A count, never content.
 */
const paidUsageSchema = z.object({
  action: z.literal('paid-usage'),
  email: z.string().email(),
});

export async function POST(req: Request) {
  if (!isTestRequestAuthorized(req)) return new Response('Not found', { status: 404 });
  try {
    const raw: unknown = await req.json();
    const usage = paidUsageSchema.safeParse(raw);
    if (usage.success) {
      return Response.json({ ok: true, ...(await readFixturePaidUsage(usage.data.email)) });
    }
    const body = bodySchema.parse(raw);
    const result = await seedFixture(body);
    return Response.json({ ok: true, ...result });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }
}
