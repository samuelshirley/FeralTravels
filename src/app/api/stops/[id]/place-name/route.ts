import { z } from 'zod';
import { assertStopOwnedByUser, errorResponse, requireEntitledUser } from '@/server/auth/guards';
import { HttpError, NotFoundError } from '@/server/auth/errors';
import { dailyReplanCapUsd, subscriberDailyCapUsd } from '@/server/payments';
import { fetchPlaceDisplayNameAccounted } from '@/server/google/accounted';
import { getStop } from '@/server/repos/stops';
import { getLegTripId } from '@/server/repos/tasks';
import { getUserUsageSummary, microcentsToDollars } from '@/server/repos/usage';
import { isPlaceId } from '@/lib/google/placeDetails';
import { STATION_NAME_CAP_REACHED, STATION_NAME_UNAVAILABLE } from '@/lib/stationName';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid() });

/**
 * A fuel station's name, fetched fresh from Google by the stop's `place_id`
 * when the driver taps for it (Sam, 2026-11-11). Google's terms (§3.2.3) forbid
 * caching business names, so the name lives only in this response: it is not
 * written to any column, log line or cache, and the response says `no-store`
 * (`stationNameGuard.test.ts`).
 *
 * Paid (Place Details Pro, $17 / 1,000 after 5,000 free a month): entitled
 * users only, owner-checked, and refused once the account's daily $ cap is
 * spent — the same cap and the same number the replan route checks. The call
 * is logged with its cost; it does not count as a Penny request.
 */
export async function GET(_req: Request, ctx: { params: { id: string } }) {
  try {
    const { id: userId, isAdmin, verdict } = await requireEntitledUser();
    const { id: stopId } = paramsSchema.parse(ctx.params);
    const legId = await assertStopOwnedByUser(stopId, userId);
    const stop = await getStop(stopId);
    if (!stop || stop.stop_type !== 'fuel' || !isPlaceId(stop.place_id)) {
      throw new NotFoundError('This stop has no station to name.');
    }

    if (!isAdmin) {
      const daily = await getUserUsageSummary(userId, 24);
      const capUsd = dailyReplanCapUsd(verdict.state, subscriberDailyCapUsd());
      if (microcentsToDollars(daily.microcents) >= capUsd) {
        throw new HttpError(429, 'Daily spend cap reached.', { code: STATION_NAME_CAP_REACHED });
      }
    }

    let name: string;
    try {
      name = await fetchPlaceDisplayNameAccounted(stop.place_id, {
        userId,
        tripId: await getLegTripId(legId),
      });
    } catch {
      // Already logged with its status by the accounted wrapper (never the
      // body). The card keeps its "Fuel stop · N km" label and says why.
      throw new HttpError(502, 'Station name unavailable.', { code: STATION_NAME_UNAVAILABLE });
    }
    return Response.json({ name }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    return errorResponse(err);
  }
}
