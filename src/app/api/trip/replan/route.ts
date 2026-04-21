import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '@/server/db/client';
import { legs, costs } from '@/server/db/schema';
import { replan } from '@/lib/claude';
import {
  requireUserId,
  assertTripOwnedByUser,
  assertLegOwnedByUser,
  assertRouteOwnedByUser,
  assertStopOwnedByUser,
  assertTaskOwnedByUser,
  errorResponse,
} from '@/server/auth/guards';
import { addChatMessage } from '@/server/repos/chat';
import { addRoute, updateRoute, deleteRoute } from '@/server/repos/routes';
import { addStop, deleteStop, updateStop } from '@/server/repos/stops';
import { addTask, updateTask, getLegTripId } from '@/server/repos/tasks';
import { addLeg, deleteLeg } from '@/server/repos/trips';
import { getDefaultVehicleForUser, getVehicleForUser } from '@/server/repos/vehicles';
import { computeEffectiveRangeKm } from '@/lib/penny/context';
import { getTripFull } from '@/server/repos/trips';
import { getUserUsageSummary, microcentsToDollars, logUsageEvent } from '@/server/repos/usage';

// Per-user spend cap and request cap on Anthropic replans.
// Update via env at any time.
const REPLAN_USD_CAP_PER_DAY = parseFloat(process.env.REPLAN_USD_CAP_PER_DAY || '5');
const REPLAN_REQUESTS_PER_HOUR = parseInt(process.env.REPLAN_REQUESTS_PER_HOUR || '40', 10);

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const inputSchema = z.object({
  tripId: z.number().int().positive(),
  message: z.string().optional().default(''),
  images: z
    .array(z.object({ dataUrl: z.string(), mediaType: z.string() }))
    .optional()
    .default([]),
});

export async function POST(req: Request) {
  // Hoisted so the catch can attribute the failure to the right user/trip in
  // usage_events even when the failure happens mid-Anthropic-call.
  let userIdForLog: string | null = null;
  let tripIdForLog: number | null = null;
  try {
    const userId = await requireUserId();
    userIdForLog = userId;
    const body = inputSchema.parse(await req.json());
    tripIdForLog = body.tripId;
    const tripId = body.tripId;
    const message = body.message ?? '';
    const images = body.images ?? [];

    if (!message && images.length === 0) {
      return Response.json({ error: 'Message or image is required' }, { status: 400 });
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      return Response.json(
        { error: 'ANTHROPIC_API_KEY not set. Add it to your .env file.' },
        { status: 500 }
      );
    }

    await assertTripOwnedByUser(tripId, userId);

    // Soft per-user spend / request guardrails to prevent runaway cost.
    const [hourly, daily] = await Promise.all([
      getUserUsageSummary(userId, 1),
      getUserUsageSummary(userId, 24),
    ]);
    if (hourly.requests >= REPLAN_REQUESTS_PER_HOUR) {
      return Response.json(
        {
          error: `Hourly Penny request limit reached (${REPLAN_REQUESTS_PER_HOUR}). Try again later.`,
        },
        { status: 429 }
      );
    }
    const dailyUsd = microcentsToDollars(daily.microcents);
    if (dailyUsd >= REPLAN_USD_CAP_PER_DAY) {
      return Response.json(
        {
          error: `Daily AI spend cap reached ($${REPLAN_USD_CAP_PER_DAY.toFixed(2)}). Resets in 24h.`,
        },
        { status: 429 }
      );
    }

    await addChatMessage(tripId, 'user', message || '(image only)');
    const result = await replan(message, tripId, images, userId);

    let appliedCount = 0;
    let failedCount = 0;
    const failedActions: Array<{ action: string; error: string }> = [];

    // Penny returns `changes` as `unknown` — narrow the envelope here so we
    // can iterate. Individual branches still coerce `change.data` fields ad
    // hoc because Claude is known to send stringly-typed numbers, undefined
    // vs null, etc.
    const changesEnvelope = result.changes as
      | { changes?: Array<Record<string, any>> }
      | null
      | undefined;
    if (changesEnvelope?.changes) {
      for (const change of changesEnvelope.changes as any[]) {
        try {
          if (change.action === 'add_leg' && change.data) {
            // Penny can propose brand-new legs when the user asks for a plan
            // from scratch (e.g. "route me from Girona to Berlin"). Without
            // this branch, the change was silently dropped while the UI still
            // showed "Changes applied to trip" — root cause of the Berlin bug.
            const d = change.data || {};
            if (!d.title || typeof d.title !== 'string') {
              throw new Error('add_leg requires a title');
            }
            await addLeg({
              tripId,
              title: d.title,
              label: d.label ?? null,
              startName: d.start_name ?? null,
              endName: d.end_name ?? null,
              startLat: d.start_lat ?? null,
              startLng: d.start_lng ?? null,
              endLat: d.end_lat ?? null,
              endLng: d.end_lng ?? null,
              dates: d.dates ?? null,
              distanceKm: d.distance_km ?? null,
              driveTimeMinutes: d.drive_time_minutes ?? null,
              terrain: d.terrain ?? null,
              overnight: d.overnight ?? null,
              status: d.status ?? null,
              color: d.color ?? null,
              notes: Array.isArray(d.notes) ? JSON.stringify(d.notes) : (d.notes ?? null),
              sortOrder: typeof d.sort_order === 'number' ? d.sort_order : null,
            });
            appliedCount += 1;
          } else if (change.action === 'delete_leg' && change.leg_id) {
            await assertLegOwnedByUser(change.leg_id, userId);
            await deleteLeg(change.leg_id);
            appliedCount += 1;
          } else if (change.action === 'update_leg' && change.leg_id && change.data) {
            await assertLegOwnedByUser(change.leg_id, userId);

            const legUpdate: Record<string, unknown> = { updatedAt: new Date() };
            const legColumnMap: Record<string, string> = {
              title: 'title',
              label: 'label',
              start_name: 'startName',
              end_name: 'endName',
              start_lat: 'startLat',
              start_lng: 'startLng',
              end_lat: 'endLat',
              end_lng: 'endLng',
              dates: 'dates',
              distance_km: 'distanceKm',
              drive_time_minutes: 'driveTimeMinutes',
              terrain: 'terrain',
              overnight: 'overnight',
              status: 'status',
              color: 'color',
            };
            let costsPayload: any[] | null = null;
            for (const [key, value] of Object.entries(change.data)) {
              if (key === 'notes' && Array.isArray(value)) {
                legUpdate.notes = JSON.stringify(value);
              } else if (key === 'costs' && Array.isArray(value)) {
                costsPayload = value;
              } else if (legColumnMap[key]) {
                legUpdate[legColumnMap[key]] = value as any;
              }
            }

            if (Object.keys(legUpdate).length > 1) {
              await db.update(legs).set(legUpdate).where(eq(legs.id, change.leg_id));
            }
            if (costsPayload) {
              await db.delete(costs).where(eq(costs.legId, change.leg_id));
              if (costsPayload.length > 0) {
                await db.insert(costs).values(
                  costsPayload.map((c: any) => ({
                    legId: change.leg_id,
                    item: String(c.item ?? ''),
                    estimate: String(c.estimate ?? ''),
                    isTotal: !!c.is_total,
                  }))
                );
              }
            }
            appliedCount += 1;
          } else if (change.action === 'add_route' && change.leg_id && change.data) {
            await assertLegOwnedByUser(change.leg_id, userId);
            const d = change.data || {};
            await addRoute({
              leg_id: change.leg_id,
              label: d.label,
              description: d.description ?? null,
              distance_km: d.distance_km ?? null,
              surface: d.surface ?? null,
              status: d.status ?? null,
              gpx_trail_id: d.gpx_trail_id ?? null,
              end_lat: d.end_lat ?? null,
              end_lng: d.end_lng ?? null,
              end_name: d.end_name ?? null,
              end_source: d.end_source ?? null,
              end_source_url: d.end_source_url ?? null,
              drive_time_minutes: d.drive_time_minutes ?? null,
              links: Array.isArray(d.links) ? d.links : undefined,
            });
            appliedCount += 1;
          } else if (change.action === 'update_route' && change.route_id && change.data) {
            await assertRouteOwnedByUser(change.route_id, userId);
            await updateRoute(change.route_id, change.data);
            appliedCount += 1;
          } else if (change.action === 'delete_route' && change.route_id) {
            await assertRouteOwnedByUser(change.route_id, userId);
            await deleteRoute(change.route_id);
            appliedCount += 1;
          } else if (change.action === 'add_stop' && change.leg_id && change.data) {
            await assertLegOwnedByUser(change.leg_id, userId);
            const d = change.data as Record<string, unknown>;
            if (typeof d.name !== 'string' || !d.name.trim()) {
              throw new Error('add_stop requires a name');
            }
            if (typeof d.stop_type !== 'string') {
              throw new Error('add_stop requires stop_type');
            }
            await addStop({
              leg_id: change.leg_id,
              stop_type: d.stop_type as 'fuel' | 'water' | 'food' | 'overnight' | 'rest' | 'other',
              name: d.name,
              status: (d.status as 'option' | 'selected' | 'dismissed' | undefined) ?? 'option',
              lat: typeof d.lat === 'number' ? d.lat : null,
              lng: typeof d.lng === 'number' ? d.lng : null,
              distance_from_start_km:
                typeof d.distance_from_start_km === 'number' ? d.distance_from_start_km : null,
              notes: typeof d.notes === 'string' ? d.notes : null,
              fuel_type:
                (d.fuel_type as 'diesel' | 'petrol' | 'premium' | 'lpg' | undefined) ?? null,
              fuel_amount_l: typeof d.fuel_amount_l === 'number' ? d.fuel_amount_l : null,
              source:
                (d.source as
                  | 'penny'
                  | 'user'
                  | 'google_places'
                  | 'osm'
                  | 'manual'
                  | undefined) ?? 'penny',
              source_url: typeof d.source_url === 'string' ? d.source_url : null,
            });
            appliedCount += 1;
          } else if (change.action === 'update_stop' && change.stop_id && change.data) {
            await assertStopOwnedByUser(change.stop_id, userId);
            await updateStop(change.stop_id, change.data as Parameters<typeof updateStop>[1]);
            appliedCount += 1;
          } else if (change.action === 'delete_stop' && change.stop_id) {
            await assertStopOwnedByUser(change.stop_id, userId);
            await deleteStop(change.stop_id);
            appliedCount += 1;
          } else if (change.action === 'plan_fuel_stops' && change.leg_id) {
            // Expand "plan_fuel_stops" into N add_stop inserts sized by the
            // vehicle's effective range. Penny emits this when a leg's
            // distance exceeds the effective range and it doesn't want to
            // guess specific stations itself.
            await assertLegOwnedByUser(change.leg_id, userId);
            const applied = await planFuelStopsForLeg(change.leg_id, tripId, userId);
            if (applied === 0) {
              throw new Error(
                'plan_fuel_stops: leg is within effective range or missing vehicle data'
              );
            }
            appliedCount += applied;
          } else if (change.action === 'add_task' && change.data) {
            const d = change.data || {};
            const legId: number | null = change.leg_id ?? null;
            if (legId) await assertLegOwnedByUser(legId, userId);
            const inferredTripId = (legId ? await getLegTripId(legId) : null) ?? tripId;
            await assertTripOwnedByUser(inferredTripId, userId);
            await addTask({
              trip_id: inferredTripId,
              leg_id: legId,
              title: d.title,
              description: d.description ?? null,
              priority: d.priority ?? null,
              status: d.status ?? null,
              reference_url: d.reference_url ?? null,
              reference_label: d.reference_label ?? null,
              reference_phone: d.reference_phone ?? null,
              created_by: 'penny',
              due_at: d.due_at ?? null,
            });
            appliedCount += 1;
          } else if (change.action === 'update_task' && change.task_id && change.data) {
            await assertTaskOwnedByUser(change.task_id, userId);
            await updateTask(change.task_id, change.data);
            appliedCount += 1;
          } else {
            // Unknown action or missing required fields — count it as failed
            // so the client can surface a real error instead of a false
            // "Changes applied" badge.
            throw new Error(
              `Unknown or incomplete action: ${(change as any)?.action ?? 'unknown'}`
            );
          }
        } catch (e) {
          failedCount += 1;
          const msg = e instanceof Error ? e.message : String(e);
          failedActions.push({ action: (change as any)?.action ?? 'unknown', error: msg });
          console.error('Failed to apply change', change, e);
        }
      }
    }

    const assistantChangesMade =
      result.changes && appliedCount > 0 ? JSON.stringify(result.changes) : null;
    await addChatMessage(tripId, 'assistant', result.response, assistantChangesMade);

    return Response.json({
      response: result.response,
      changes: result.changes,
      appliedCount,
      failedCount,
      failedActions,
    });
  } catch (err) {
    // Log fatal replan failures to usage_events so they show up in the admin
    // Recent errors log. Per-action failures (add_leg etc) are already handled
    // inline above with failedActions/failedCount.
    await logUsageEvent({
      userId: userIdForLog,
      tripId: tripIdForLog,
      provider: 'anthropic:replan',
      requests: 1,
      success: false,
      errorMessage: err instanceof Error ? err.message : String(err),
    }).catch(() => {});
    return errorResponse(err);
  }
}

/**
 * Expand a `plan_fuel_stops` action into concrete add_stop inserts.
 *
 * Strategy: look up the leg's distance and the driver's vehicle, derive the
 * effective range (tank × economy − reserve), and place fuel stops at
 * `effective_range_km` intervals along the leg. We don't know real station
 * locations, so we seed placeholder stops named "Refuel near km N" with
 * source='penny' so the user knows to replace them. Interpolation uses
 * straight-line coordinates between the leg start and end — good enough for
 * the UI to render pins; the user will refine when they swap in real stops.
 */
async function planFuelStopsForLeg(
  legId: number,
  tripId: number,
  userId: string
): Promise<number> {
  const trip = await getTripFull(tripId);
  if (!trip) return 0;
  const leg = trip.legs.find((l) => l.id === legId);
  if (!leg || leg.distance_km == null) return 0;

  const vehicle =
    (trip.vehicle_id != null
      ? await getVehicleForUser(userId, trip.vehicle_id).catch(() => null)
      : null) ?? (await getDefaultVehicleForUser(userId).catch(() => null));
  if (!vehicle) return 0;

  const effectiveRangeKm = computeEffectiveRangeKm(
    vehicle.fuel_economy_kmpl,
    vehicle.fuel_tank_l
  );
  if (effectiveRangeKm == null || effectiveRangeKm <= 0) return 0;
  if (leg.distance_km <= effectiveRangeKm) return 0;

  const stops: number[] = [];
  for (let km = effectiveRangeKm; km < leg.distance_km; km += effectiveRangeKm) {
    stops.push(km);
  }
  if (stops.length === 0) return 0;

  let applied = 0;
  for (const km of stops) {
    const fraction = km / leg.distance_km;
    const lat =
      leg.start_lat != null && leg.end_lat != null
        ? leg.start_lat + (leg.end_lat - leg.start_lat) * fraction
        : null;
    const lng =
      leg.start_lng != null && leg.end_lng != null
        ? leg.start_lng + (leg.end_lng - leg.start_lng) * fraction
        : null;
    await addStop({
      leg_id: legId,
      stop_type: 'fuel',
      name: `Refuel near km ${Math.round(km)}`,
      status: 'option',
      lat,
      lng,
      distance_from_start_km: km,
      fuel_type: (vehicle.fuel_type as 'diesel' | 'petrol' | 'premium' | 'lpg' | null) ?? null,
      source: 'penny',
      notes: 'Placeholder — swap in a real station once picked on the map.',
    });
    applied += 1;
  }
  return applied;
}
