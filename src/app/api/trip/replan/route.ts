import { z } from 'zod';
import { desc, eq } from 'drizzle-orm';
import { db } from '@/server/db/client';
import { legs, costs } from '@/server/db/schema';
import { replanStream, type ReplanEvent } from '@/lib/claude';
import type { ReplanResult } from '@/lib/claude';
import type { ValidatedAction } from '@/lib/penny/tools';
import {
  requireUser,
  assertTripOwnedByUser,
  assertLegOwnedByUser,
  assertRouteOwnedByUser,
  assertStopOwnedByUser,
  assertTaskOwnedByUser,
  errorResponse,
  ForbiddenError,
  NotFoundError,
} from '@/server/auth/guards';
import { addChatMessage } from '@/server/repos/chat';
import { addRoute, updateRoute, deleteRoute } from '@/server/repos/routes';
import { addStop, deleteStop, updateStop } from '@/server/repos/stops';
import { addTask, updateTask, getLegTripId } from '@/server/repos/tasks';
import { addLeg, deleteLeg, getTripFull } from '@/server/repos/trips';
import { updateVehicle, getVehicleForUser, getDefaultVehicleForUser } from '@/server/repos/vehicles';
import { getUserUsageSummary, microcentsToDollars, logUsageEvent } from '@/server/repos/usage';
import { getDirections } from '@/lib/google/directions';
import type { GeoJSONLineString } from '@/server/db/schema';

/** One POST /api/trip/replan: queue `add_leg` ids so `plan_fuel_stops` can recover from guessed leg_id. */
type ReplanDispatchCtx = { newLegIdsQueue: string[] };

function assertLegOnTrip(legTripId: string, tripId: string): void {
  if (legTripId !== tripId) throw new ForbiddenError('Leg is not part of this trip');
}

async function getLatestLegIdOnTrip(targetTripId: string): Promise<string | null> {
  const rows = await db
    .select({ id: legs.id })
    .from(legs)
    .where(eq(legs.tripId, targetTripId))
    .orderBy(desc(legs.sortOrder))
    .limit(1);
  return rows[0]?.id ?? null;
}

/**
 * Map a Penny-proposed leg id onto a leg that actually belongs to this trip.
 *
 * Claude sometimes sends ids from stale context or guesses before sibling
 * `add_leg` rows exist. We validate with ownership + trip containment first;
 * then (when opts allow) fall back like `plan_fuel_stops`: dequeue an id
 * persisted earlier in this same dispatch batch.
 *
 * Note: the old sort_order fallback (matching small integers Penny sometimes
 * echoed) has been removed since UUIDs can't be confused with sort_orders.
 */
async function resolvePennyLegIdOnTrip(
  proposedLegId: string,
  tripId: string,
  userId: string,
  ctx: ReplanDispatchCtx,
  opts?: { dequeueNewLegFallback?: boolean }
): Promise<string> {
  async function resolveLeg(candidate: string): Promise<void> {
    const ownerTripId = await assertLegOwnedByUser(candidate, userId);
    assertLegOnTrip(ownerTripId, tripId);
  }

  try {
    await resolveLeg(proposedLegId);
    return proposedLegId;
  } catch (e) {
    const wrongTrip =
      e instanceof ForbiddenError && e.message === 'Leg is not part of this trip';
    if (!(e instanceof NotFoundError) && !wrongTrip) throw e;

    if (opts?.dequeueNewLegFallback && ctx.newLegIdsQueue.length > 0) {
      const fallback = ctx.newLegIdsQueue.shift()!;
      try {
        await resolveLeg(fallback);
        return fallback;
      } catch (e2) {
        ctx.newLegIdsQueue.unshift(fallback);
        throw e2;
      }
    }

    throw e;
  }
}

/**
 * Resolve a Penny-proposed leg id for add_stop.
 *
 * With UUIDs there's no sort_order confusion — the proposed id is either a
 * valid leg UUID on this trip or it isn't. No silent fallback to the latest
 * leg — that caused stops to land on completely unrelated legs.
 *
 * If the proposed id is not a valid leg on this trip, we throw so the action
 * fails visibly and Penny can retry with correct data.
 */
async function resolvePennyStopLegId(
  proposedLegId: string,
  tripId: string,
  userId: string,
  _ctx: ReplanDispatchCtx
): Promise<string> {
  const ownerTripId = await assertLegOwnedByUser(proposedLegId, userId);
  assertLegOnTrip(ownerTripId, tripId);
  return proposedLegId;
}

function actionShouldTriggerTripFuelReplenish(action: ValidatedAction): boolean {
  if (
    action.name === 'add_leg' ||
    action.name === 'delete_leg' ||
    action.name === 'update_leg' ||
    action.name === 'plan_fuel_stops'
  ) {
    return true;
  }
  if (action.name === 'add_stop' && action.input.data.stop_type === 'fuel') {
    return true;
  }
  return false;
}

// Per-user spend cap and request cap on Anthropic replans.
// Update via env at any time.
const REPLAN_USD_CAP_PER_DAY = parseFloat(process.env.REPLAN_USD_CAP_PER_DAY || '5');
const REPLAN_REQUESTS_PER_HOUR = parseInt(process.env.REPLAN_REQUESTS_PER_HOUR || '40', 10);

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300; // Anthropic calls can take >60s on complex trips

/**
 * Hard cap on the size of a single chat message. The textarea has no
 * character limit on the client (deliberate — copy-paste friendliness),
 * so this is the server-side anti-spam guard. 4000 chars ≈ ~1000 tokens
 * — plenty for "plan a 14-day trip from X to Y hitting A, B, C" with
 * room for elaboration. Anything larger is almost certainly someone
 * pasting junk to burn tokens.
 *
 * Defense in depth: REPLAN_REQUESTS_PER_HOUR (40) and
 * REPLAN_USD_CAP_PER_DAY ($5) cap the total damage even if individual
 * messages slip through long.
 */
const MAX_MESSAGE_CHARS = 4000;

const inputSchema = z.object({
  tripId: z.string().uuid(),
  message: z.string().max(MAX_MESSAGE_CHARS).optional().default(''),
  images: z
    .array(z.object({ dataUrl: z.string(), mediaType: z.string() }))
    .optional()
    .default([]),
});

export async function POST(req: Request) {
  // Hoisted so the catch can attribute the failure to the right user/trip in
  // usage_events even when the failure happens mid-Anthropic-call.
  let userIdForLog: string | null = null;
  let tripIdForLog: string | null = null;
  /** After the user bubble is persisted; used to add an assistant error bubble on fatal throw. */
  let userTurnSaved = false;
  try {
    const { id: userId, isAdmin: isAdminUser } = await requireUser();
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
      // Log so it shows up in /admin/errors, but don't expose env var details to users.
      await logUsageEvent({
        userId: userIdForLog,
        tripId: tripIdForLog,
        provider: 'anthropic:replan',
        requests: 1,
        success: false,
        errorMessage: 'ANTHROPIC_API_KEY is not set',
      }).catch(() => {});
      return Response.json(
        { error: 'AI service is temporarily unavailable. Please try again later.' },
        { status: 503 }
      );
    }

    await assertTripOwnedByUser(tripId, userId);

    // Soft per-user spend / request guardrails to prevent runaway cost.
    //
    // Admins (defined by the hardcoded allowlist in src/server/auth/admin.ts)
    // are exempt from both caps so the operator can debug, demo, or stress-
    // test without locking themselves out. Everyone else hits the same
    // hourly request and daily $ caps. We still record their usage events
    // below — exemption is on the gate, not on the accounting.
    if (!isAdminUser) {
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
    }

    await addChatMessage(tripId, 'user', message || '(image only)');
    userTurnSaved = true;

    // Stream Penny's progress so the user sees each paragraph + tool-call
    // status pill as it lands instead of the whole turn buffering for
    // ~10-30s. Format is plain Server-Sent Events: each event is a single
    // `data: <json>\n\n` frame. Final dispatch (DB writes, fuel replenish
    // queue, etc.) runs after the model loop terminates and emits a
    // synthetic `applied` event with the same shape the old JSON response
    // used. See ChatPanel.sendChatMessage for the consumer.
    const encoder = new TextEncoder();
    let clientDisconnected = false;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        // Wrap enqueue so a client disconnect (PWA closed, tab closed,
        // network drop) doesn't kill the entire async function. We still
        // want the dispatch to complete and persist changes even if nobody
        // is reading the SSE stream anymore.
        const send = (e: Record<string, unknown>) => {
          if (clientDisconnected) return;
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
          } catch {
            clientDisconnected = true;
          }
        };
        try {
          let final: ReplanResult | null = null;
          for await (const ev of replanStream(message, tripId, images, userId)) {
            // The model loop yields a terminal `done` event with the full
            // ReplanResult — we don't forward that to the client. Instead
            // we synthesize the post-dispatch `applied` event below.
            if (ev.kind === 'done') {
              final = ev.result;
              continue;
            }
            send(ev satisfies ReplanEvent);
          }

          if (!final) throw new Error('replanStream finished without a result');

          if (final.truncated) {
            logUsageEvent({
              userId,
              tripId,
              provider: 'anthropic:replan-truncated',
              requests: 1,
              success: true,
              errorMessage: 'Tool-use loop hit MAX_TOOL_USE_ITERATIONS',
            }).catch((e) => console.warn('logUsageEvent (truncation) failed:', e));
          }

          let appliedCount = 0;
          /** Total failures incl. exhausted validation retries (legacy / ops). */
          let failedCount = 0;
          const failedActions: Array<{ action: string; error: string }> = [];
          /** DB / feasibility outcomes only — authoritative for user-facing banners. */
          let persistFailedCount = 0;
          const persistFailedActions: Array<{ action: string; error: string }> = [];
          const validationFailures: Array<{ action: string; error: string }> = [];

          const appliedActions: ValidatedAction[] = [];

          for (const v of final.failedValidations) {
            failedCount += 1;
            const row = { action: v.tool, error: v.error };
            failedActions.push(row);
            validationFailures.push(row);
          }

          const feasibilityGateActive = final.extractIntentCalled;
          const feasibilityGateBlocks =
            feasibilityGateActive &&
            (final.feasibilityVerdict === null ||
              final.feasibilityVerdict === 'over_budget');

          // Pre-dispatch contiguity gate: simulate the final leg state and
          // reject any delete_leg that would leave a gap in the route. Penny
          // sometimes deletes a leg without updating the neighbor to close
          // the gap, leaving a hole in the map.
          const blockedDeleteLegIds = await findGapCreatingDeletes(
            tripId,
            final.validatedActions
          );

          const dispatchCtx: ReplanDispatchCtx = { newLegIdsQueue: [] };
          for (const action of final.validatedActions) {
            if (feasibilityGateBlocks && action.name === 'add_leg') {
              failedCount += 1;
              const row = {
                action: 'add_leg',
                error:
                  final.feasibilityVerdict === 'over_budget'
                    ? 'Plan rejected — exceeds your time budget. Penny should have asked you to extend the trip or drop a stop before saving.'
                    : 'Plan rejected — Penny did not run the feasibility check before saving. Ask her to retry the plan.',
              } as const;
              failedActions.push(row);
              persistFailedCount += 1;
              persistFailedActions.push(row);
              continue;
            }
            // Block delete_leg actions that would create a contiguity gap
            if (action.name === 'delete_leg' && blockedDeleteLegIds.has(action.input.leg_id)) {
              failedCount += 1;
              const row = {
                action: 'delete_leg',
                error:
                  'Blocked: deleting this leg would break route continuity. ' +
                  'The neighboring leg must be updated to close the gap first.',
              };
              failedActions.push(row);
              persistFailedCount += 1;
              persistFailedActions.push(row);
              logUsageEvent({
                userId,
                tripId,
                provider: 'penny:contiguity-blocked-delete',
                requests: 0,
                success: false,
                errorMessage: `delete_leg ${action.input.leg_id} blocked by pre-dispatch contiguity gate`,
              }).catch(() => {});
              continue;
            }
            try {
              await dispatchAction(action, tripId, userId, dispatchCtx);
              appliedActions.push(action);
              appliedCount += 1;
            } catch (e) {
              failedCount += 1;
              const msg = e instanceof Error ? e.message : String(e);
              const row = { action: action.name, error: msg };
              failedActions.push(row);
              persistFailedCount += 1;
              persistFailedActions.push(row);
              console.error('Failed to apply validated action', action, e);
              // Log each persist failure individually so they appear in admin errors
              logUsageEvent({
                userId,
                tripId,
                provider: `penny:persist-fail:${action.name}`,
                requests: 0,
                success: false,
                errorMessage: `${action.name}: ${msg}`.slice(0, 500),
              }).catch(() => {});
            }
          }

          // Post-dispatch leg contiguity check: detect if Penny left a gap
          // (e.g. deleted a leg without updating the neighbor). Log so it
          // shows up in admin errors — don't block the response.
          if (appliedCount > 0) {
            checkLegContiguity(tripId, userId).catch((e) =>
              console.warn('[contiguity-check] failed', e)
            );
          }

          const fuelReplenishQueued = appliedActions.some(
            actionShouldTriggerTripFuelReplenish
          );

          const changesEnvelope = {
            changes: appliedActions.map(actionToLegacyChange),
          };

          const validatedQueuedCount = final.validatedActions.length;

          // Build a deterministic route summary from the actual DB state
          // after actions land. This is the ground truth — Penny's prose
          // may say "through Italy" while the legs actually go through
          // Switzerland. The client can display this so the user always
          // sees what the route *actually* is, regardless of Penny's
          // autoregressive text.
          let routeSummary: string | null = null;
          if (appliedCount > 0) {
            try {
              routeSummary = await buildRouteSummary(tripId);
            } catch (e) {
              console.warn('[route-summary] failed to build', e);
            }
          }

          const assistantChangesMade =
            appliedCount > 0 ? JSON.stringify(changesEnvelope) : null;
          await addChatMessage(tripId, 'assistant', final.response, assistantChangesMade);

          // Terminal event. Same shape as the old JSON response so the
          // client doesn't need two parsers. `failedCount`/`failedActions`
          // remain the merged total (validation + persist) for ops/logging;
          // user-facing banners should use `persistFailed*` only.
          send({
            kind: 'applied',
            response: final.response,
            changes: changesEnvelope,
            appliedCount,
            failedCount,
            failedActions,
            persistFailedCount,
            persistFailedActions,
            validationFailures,
            /** Count of Penny actions that validated and queued for dispatch (incl. failed persist). */
            validatedQueuedCount,
            fuelReplenishQueued,
            routeSummary,
            retryCount: final.retryCount,
            truncated: final.truncated,
          });
        } catch (err) {
          console.error('replan stream failed', err);
          // Best-effort: surface a chat bubble so the user knows the turn
          // failed. The outer try/catch above (for input parse errors etc.)
          // does the same — this branch covers errors that surface AFTER
          // the user message was already saved.
          await addChatMessage(
            tripId,
            'assistant',
            'Something went wrong while updating your trip. Please try again.',
            null
          ).catch(() => {});
          await logUsageEvent({
            userId,
            tripId,
            provider: 'anthropic:replan',
            requests: 1,
            success: false,
            errorMessage: err instanceof Error ? err.message : String(err),
          }).catch(() => {});
          send({
            kind: 'error',
            message: err instanceof Error ? err.message : String(err),
          });
        } finally {
          try {
            controller.close();
          } catch {
            // Already closed or client disconnected — safe to ignore
          }
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        // Disable nginx/Vercel proxy buffering so events flush in real time
        // instead of being held until the response completes.
        'X-Accel-Buffering': 'no',
        Connection: 'keep-alive',
      },
    });
  } catch (err) {
    if (userTurnSaved && tripIdForLog != null) {
      await addChatMessage(
        tripIdForLog,
        'assistant',
        'Something went wrong while updating your trip. Please try again.',
        null
      ).catch(() => {});
    }
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

// ---------------------------------------------------------------------------
// Action dispatcher
//
// One switch arm per ValidatedAction.name. The TypeScript discriminated union
// on `action.name` narrows `action.input` to the exact tool-input shape so
// each branch can read fields directly without `as any`. Every branch is
// responsible for: (a) ownership assertions, (b) translating snake_case tool
// inputs into the camelCase shape the repo helpers expect, (c) handling the
// quirky bits (notes JSON-ification, costs delete-then-reinsert, etc.).
// ---------------------------------------------------------------------------
async function dispatchAction(
  action: ValidatedAction,
  tripId: string,
  userId: string,
  ctx: ReplanDispatchCtx
): Promise<void> {
  switch (action.name) {
    case 'update_vehicle': {
      // The vehicle to update is the one in the trip's context — the same
      // vehicle Penny was given at the start of this turn. We resolve it the
      // same way buildPennyContext does: prefer trip.vehicle_id, fall back to
      // the user's default. We re-fetch here (rather than threading the id
      // through from context) so this dispatch path is self-contained and the
      // ownership check is always fresh.
      const trip = await getTripFull(tripId);
      if (!trip) throw new NotFoundError('Trip not found');

      let vehicleId: string | null = trip.vehicle_id ?? null;
      if (vehicleId == null) {
        const def = await getDefaultVehicleForUser(userId);
        vehicleId = def?.id ?? null;
      } else {
        // Verify the user owns the vehicle referenced by the trip.
        const owned = await getVehicleForUser(userId, vehicleId);
        if (!owned) throw new ForbiddenError('Vehicle is not owned by this user');
      }

      if (vehicleId == null) {
        throw new NotFoundError(
          'No vehicle found for this trip. Add a vehicle in settings first.'
        );
      }

      const updated = await updateVehicle(userId, vehicleId, action.input.data);
      if (!updated) throw new NotFoundError('Vehicle not found or not owned by user');
      return;
    }

    case 'add_leg': {
      const d = action.input;

      // Fetch driving geometry at creation time so the UI never needs to call
      // external APIs. This uses the same Google Directions API that get_route
      // calls — the polyline is already cached if Penny just called get_route
      // for these coords (24h LRU in directions.ts).
      let geometry: GeoJSONLineString | null = null;
      if (d.start_lat != null && d.start_lng != null && d.end_lat != null && d.end_lng != null) {
        const dir = await getDirections(
          { lat: d.start_lat, lng: d.start_lng },
          { lat: d.end_lat, lng: d.end_lng },
        );
        if (dir.ok && dir.polyline_points.length > 0) {
          geometry = {
            type: 'LineString',
            // GeoJSON uses [lng, lat] order
            coordinates: dir.polyline_points.map(([lat, lng]) => [lng, lat]),
          };
        }
      }

      const newLegId = await addLeg({
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
        notes: Array.isArray(d.notes) ? JSON.stringify(d.notes) : null,
        sortOrder: d.sort_order ?? null,
        segmentIndex: d.segment_index ?? null,
        segmentName: d.segment_name ?? null,
        geometry,
      });
      ctx.newLegIdsQueue.push(newLegId);
      return;
    }

    case 'delete_leg': {
      const leg_id = await resolvePennyLegIdOnTrip(action.input.leg_id, tripId, userId, ctx);
      await deleteLeg(leg_id);
      return;
    }

    case 'update_leg': {
      let { leg_id, data } = action.input;
      leg_id = await resolvePennyLegIdOnTrip(leg_id, tripId, userId, ctx, {
        dequeueNewLegFallback: true,
      });

      // Manual update + per-row costs replacement preserved from the
      // pre-tool-use version. The shape mismatch (snake_case from Penny vs
      // camelCase columns) is handled here rather than in the repo because
      // it's the only caller doing partial multi-column updates.
      const legUpdate: Record<string, unknown> = { updatedAt: new Date() };
      if (data.title !== undefined) legUpdate.title = data.title;
      if (data.label !== undefined) legUpdate.label = data.label;
      if (data.start_name !== undefined) legUpdate.startName = data.start_name;
      if (data.end_name !== undefined) legUpdate.endName = data.end_name;
      if (data.start_lat !== undefined) legUpdate.startLat = data.start_lat;
      if (data.start_lng !== undefined) legUpdate.startLng = data.start_lng;
      if (data.end_lat !== undefined) legUpdate.endLat = data.end_lat;
      if (data.end_lng !== undefined) legUpdate.endLng = data.end_lng;
      if (data.dates !== undefined) legUpdate.dates = data.dates;
      if (data.distance_km !== undefined) legUpdate.distanceKm = data.distance_km;
      if (data.drive_time_minutes !== undefined)
        legUpdate.driveTimeMinutes = data.drive_time_minutes;
      if (data.terrain !== undefined) legUpdate.terrain = data.terrain;
      if (data.overnight !== undefined) legUpdate.overnight = data.overnight;
      if (data.status !== undefined) legUpdate.status = data.status;
      if (data.color !== undefined) legUpdate.color = data.color;
      if (data.notes !== undefined)
        legUpdate.notes = Array.isArray(data.notes) ? JSON.stringify(data.notes) : null;
      if (data.segment_index !== undefined) legUpdate.segmentIndex = data.segment_index;
      if (data.segment_name !== undefined) legUpdate.segmentName = data.segment_name;

      // If start or end coords changed, re-fetch driving geometry so the
      // stored polyline stays in sync with the leg endpoints.
      const coordsChanged =
        data.start_lat !== undefined ||
        data.start_lng !== undefined ||
        data.end_lat !== undefined ||
        data.end_lng !== undefined;
      if (coordsChanged) {
        // Resolve final coords: use updated values where provided, fall back
        // to existing DB values for unchanged coords.
        const existing = await db.select().from(legs).where(eq(legs.id, leg_id)).limit(1);
        const cur = existing[0];
        const sLat = data.start_lat ?? cur?.startLat;
        const sLng = data.start_lng ?? cur?.startLng;
        const eLat = data.end_lat ?? cur?.endLat;
        const eLng = data.end_lng ?? cur?.endLng;
        if (sLat != null && sLng != null && eLat != null && eLng != null) {
          const dir = await getDirections({ lat: sLat, lng: sLng }, { lat: eLat, lng: eLng });
          if (dir.ok && dir.polyline_points.length > 0) {
            legUpdate.geometry = {
              type: 'LineString',
              coordinates: dir.polyline_points.map(([lat, lng]) => [lng, lat]),
            };
          } else {
            legUpdate.geometry = null;
          }
        }
      }

      // updatedAt is always set; only run the SQL update if at least one
      // real column changed.
      if (Object.keys(legUpdate).length > 1) {
        await db.update(legs).set(legUpdate).where(eq(legs.id, leg_id));
      }

      if (data.costs != null) {
        await db.delete(costs).where(eq(costs.legId, leg_id));
        if (data.costs.length > 0) {
          await db.insert(costs).values(
            data.costs.map((c) => ({
              legId: leg_id,
              item: c.item,
              estimate: c.estimate,
              isTotal: !!c.is_total,
            }))
          );
        }
      }
      return;
    }

    case 'add_route': {
      const { data } = action.input;
      const leg_id = await resolvePennyLegIdOnTrip(action.input.leg_id, tripId, userId, ctx);
      await addRoute({
        leg_id,
        label: data.label,
        description: data.description ?? null,
        distance_km: data.distance_km ?? null,
        surface: data.surface ?? null,
        status: data.status ?? null,
        gpx_trail_id: data.gpx_trail_id ?? null,
        end_lat: data.end_lat ?? null,
        end_lng: data.end_lng ?? null,
        end_name: data.end_name ?? null,
        end_source: data.end_source ?? null,
        end_source_url: data.end_source_url ?? null,
        drive_time_minutes: data.drive_time_minutes ?? null,
        links: data.links ?? undefined,
      });
      return;
    }

    case 'update_route': {
      const { route_id, data } = action.input;
      await assertRouteOwnedByUser(route_id, userId);
      // The route repo's updateRoute doesn't take a `links` field — it only
      // mutates the routes row. Strip links here so we don't pass an
      // unsupported key (matches pre-existing behaviour).
      const { links: _ignoredLinks, ...rest } = data;
      await updateRoute(route_id, rest as Parameters<typeof updateRoute>[1]);
      return;
    }

    case 'delete_route': {
      await assertRouteOwnedByUser(action.input.route_id, userId);
      await deleteRoute(action.input.route_id);
      return;
    }

    case 'add_stop': {
      const { leg_id: proposedLegId, data } = action.input;
      const leg_id = await resolvePennyStopLegId(proposedLegId, tripId, userId, ctx);
      await addStop({
        leg_id,
        stop_type: data.stop_type,
        name: data.name,
        status: data.status ?? 'option',
        lat: data.lat ?? null,
        lng: data.lng ?? null,
        distance_from_start_km: data.distance_from_start_km ?? null,
        notes: data.notes ?? null,
        fuel_type: data.fuel_type ?? null,
        fuel_amount_l: data.fuel_amount_l ?? null,
        source: data.source ?? 'penny',
        source_url: data.source_url ?? null,
      });
      return;
    }

    case 'update_stop': {
      const { stop_id, data } = action.input;
      await assertStopOwnedByUser(stop_id, userId);
      // The repo's UpdateStopInput is structurally compatible with the
      // validated tool input — both use snake_case and accept `null` on the
      // nullable fields. Pass through.
      await updateStop(stop_id, data as Parameters<typeof updateStop>[1]);
      return;
    }

    case 'delete_stop': {
      await assertStopOwnedByUser(action.input.stop_id, userId);
      await deleteStop(action.input.stop_id);
      return;
    }

    case 'plan_fuel_stops': {
      await resolvePennyLegIdOnTrip(action.input.leg_id, tripId, userId, ctx, {
        dequeueNewLegFallback: true,
      });
      // Trip-wide replen runs after the batch when `fuelReplenishQueued` is
      // set — keeps cumulative range across legs consistent.
      return;
    }

    case 'add_task': {
      const { leg_id, data } = action.input;
      const resolvedLegId = leg_id ?? null;
      if (resolvedLegId != null) await assertLegOwnedByUser(resolvedLegId, userId);
      const inferredTripId =
        (resolvedLegId != null ? await getLegTripId(resolvedLegId) : null) ?? tripId;
      await assertTripOwnedByUser(inferredTripId, userId);
      await addTask({
        trip_id: inferredTripId,
        leg_id: resolvedLegId,
        title: data.title,
        description: data.description ?? null,
        priority: data.priority ?? null,
        reference_url: data.reference_url ?? null,
        reference_label: data.reference_label ?? null,
        reference_phone: data.reference_phone ?? null,
        created_by: 'penny',
        due_at: data.due_at ?? null,
      });
      return;
    }

    case 'update_task': {
      const { task_id, data } = action.input;
      await assertTaskOwnedByUser(task_id, userId);
      await updateTask(task_id, data as Parameters<typeof updateTask>[1]);
      return;
    }

    default: {
      // Exhaustive switch — TS will flag any unhandled member of the union
      // here at compile time.
      const _exhaustive: never = action;
      throw new Error(`Unhandled action: ${(_exhaustive as { name: string }).name}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Pre-dispatch contiguity gate
//
// Before committing actions, simulate the final leg state and reject any
// delete_leg that would leave a gap (>50 km) between consecutive legs. Penny
// sometimes deletes a leg without updating the neighbor to close the gap.
// Returns the set of Penny-proposed leg_ids (pre-resolution) that should be
// blocked from dispatch.
// ---------------------------------------------------------------------------

type SimLeg = {
  id: string;
  sortOrder: number | null;
  startLat: number | null;
  startLng: number | null;
  endLat: number | null;
  endLng: number | null;
};

/**
 * In-memory resolve: mirrors resolvePennyLegIdOnTrip but against a Map
 * instead of the DB. Returns the real leg id or null if unresolvable.
 * With UUIDs there's no sort_order confusion — just a direct Map lookup.
 */
function simResolveId(proposedId: string, legMap: Map<string, SimLeg>): string | null {
  if (legMap.has(proposedId)) return proposedId;
  return null;
}

/** Check whether a sorted leg array has any contiguity gap >threshold. */
function simHasGaps(sortedLegs: SimLeg[]): boolean {
  for (let i = 0; i < sortedLegs.length - 1; i++) {
    const curr = sortedLegs[i];
    const next = sortedLegs[i + 1];
    if (
      curr.endLat == null || curr.endLng == null ||
      next.startLat == null || next.startLng == null
    ) continue;
    if (haversineKm(curr.endLat, curr.endLng, next.startLat, next.startLng) > LEG_GAP_THRESHOLD_KM) {
      return true;
    }
  }
  return false;
}

async function findGapCreatingDeletes(
  tripId: string,
  actions: ValidatedAction[]
): Promise<Set<string>> {
  // 1. Load current legs
  const currentLegs = await db
    .select({
      id: legs.id,
      sortOrder: legs.sortOrder,
      startLat: legs.startLat,
      startLng: legs.startLng,
      endLat: legs.endLat,
      endLng: legs.endLng,
    })
    .from(legs)
    .where(eq(legs.tripId, tripId))
    .orderBy(legs.sortOrder);

  const deleteActions = actions.filter(
    (a): a is ValidatedAction & { name: 'delete_leg' } => a.name === 'delete_leg'
  );

  // No deletes or fewer than 2 legs → nothing to check
  if (deleteActions.length === 0 || currentLegs.length < 2) return new Set();

  // 2. Simulate all actions on a mutable copy
  const legMap = new Map<string, SimLeg>();
  for (const leg of currentLegs) {
    legMap.set(leg.id, { ...leg });
  }

  // Max sort_order for add_leg entries without an explicit sort_order
  let maxSort = currentLegs.reduce(
    (mx, l) => Math.max(mx, l.sortOrder ?? 0),
    0
  );
  let syntheticIdCounter = 0;

  for (const action of actions) {
    switch (action.name) {
      case 'update_leg': {
        const resolved = simResolveId(action.input.leg_id, legMap);
        if (resolved != null) {
          const leg = legMap.get(resolved)!;
          const d = action.input.data;
          if (d.start_lat !== undefined) leg.startLat = d.start_lat ?? null;
          if (d.start_lng !== undefined) leg.startLng = d.start_lng ?? null;
          if (d.end_lat !== undefined) leg.endLat = d.end_lat ?? null;
          if (d.end_lng !== undefined) leg.endLng = d.end_lng ?? null;
        }
        break;
      }
      case 'add_leg': {
        const synId = `__synthetic_${syntheticIdCounter++}`;
        const so = action.input.sort_order ?? ++maxSort;
        legMap.set(synId, {
          id: synId,
          sortOrder: so,
          startLat: action.input.start_lat ?? null,
          startLng: action.input.start_lng ?? null,
          endLat: action.input.end_lat ?? null,
          endLng: action.input.end_lng ?? null,
        });
        break;
      }
      case 'delete_leg': {
        const resolved = simResolveId(action.input.leg_id, legMap);
        if (resolved != null) legMap.delete(resolved);
        break;
      }
      // Other action types don't affect leg geometry
      default:
        break;
    }
  }

  // 3. Sort remaining legs and check for gaps
  const finalLegs = [...legMap.values()].sort(
    (a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)
  );

  if (finalLegs.length < 2 || !simHasGaps(finalLegs)) {
    return new Set();
  }

  // 4. Gaps detected — identify culprit deletes by re-simulating without each
  //    one. If un-deleting a leg removes all gaps, that delete is the culprit.
  const blockedIds = new Set<string>();

  for (const del of deleteActions) {
    // Rebuild simulated state skipping this one delete
    const testMap = new Map<string, SimLeg>();
    for (const leg of currentLegs) {
      testMap.set(leg.id, { ...leg });
    }
    let testMaxSort = maxSort;
    let testSynCounter = 0;

    // Resolve this delete's target so we can skip it
    const delResolved = simResolveId(
      del.input.leg_id,
      // Use a fresh map for resolution (before any mutations)
      new Map<string, SimLeg>(currentLegs.map((l) => [l.id, { ...l }]))
    );

    for (const action of actions) {
      switch (action.name) {
        case 'update_leg': {
          const r = simResolveId(action.input.leg_id, testMap);
          if (r != null) {
            const leg = testMap.get(r)!;
            const d = action.input.data;
            if (d.start_lat !== undefined) leg.startLat = d.start_lat ?? null;
            if (d.start_lng !== undefined) leg.startLng = d.start_lng ?? null;
            if (d.end_lat !== undefined) leg.endLat = d.end_lat ?? null;
            if (d.end_lng !== undefined) leg.endLng = d.end_lng ?? null;
          }
          break;
        }
        case 'add_leg': {
          const synId = `__test_synthetic_${testSynCounter++}`;
          const so = action.input.sort_order ?? ++testMaxSort;
          testMap.set(synId, {
            id: synId,
            sortOrder: so,
            startLat: action.input.start_lat ?? null,
            startLng: action.input.start_lng ?? null,
            endLat: action.input.end_lat ?? null,
            endLng: action.input.end_lng ?? null,
          });
          break;
        }
        case 'delete_leg': {
          const r = simResolveId(action.input.leg_id, testMap);
          // Skip the delete we're testing
          if (r != null && r !== delResolved) {
            testMap.delete(r);
          }
          break;
        }
        default:
          break;
      }
    }

    const testFinal = [...testMap.values()].sort(
      (a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)
    );
    if (!simHasGaps(testFinal)) {
      blockedIds.add(del.input.leg_id);
    }
  }

  // If gaps exist but no single delete is the isolated cause (e.g., two
  // deletes each partially contribute), block all deletes conservatively.
  // A leg that stays is always safer than a gap in the route.
  if (blockedIds.size === 0) {
    for (const del of deleteActions) {
      blockedIds.add(del.input.leg_id);
    }
  }

  return blockedIds;
}

// ---------------------------------------------------------------------------
// Post-dispatch deterministic route summary
//
// After actions land, read the actual leg state from the DB and produce a
// short, factual description of the route. This is the ground truth that the
// frontend can display underneath Penny's prose — eliminating the hallucination
// problem where Penny says "through Italy" but the legs go through Switzerland.
// ---------------------------------------------------------------------------

async function buildRouteSummary(tripId: string): Promise<string | null> {
  const tripLegs = await db
    .select({
      sortOrder: legs.sortOrder,
      startName: legs.startName,
      endName: legs.endName,
      distanceKm: legs.distanceKm,
      driveTimeMinutes: legs.driveTimeMinutes,
      dates: legs.dates,
      title: legs.title,
    })
    .from(legs)
    .where(eq(legs.tripId, tripId))
    .orderBy(legs.sortOrder);

  if (tripLegs.length === 0) return null;

  // Build a concise day-by-day summary:
  // "Day 1: Girona → Montpellier (350 km, ~4.5 hrs) | Day 2: Montpellier → Annecy (420 km, ~5 hrs) | ..."
  const dayParts: string[] = [];
  let totalKm = 0;
  let totalMinutes = 0;

  for (let i = 0; i < tripLegs.length; i++) {
    const leg = tripLegs[i];
    const label = leg.title || `Day ${i + 1}`;
    const from = leg.startName || '?';
    const to = leg.endName || '?';

    let details = `${from} → ${to}`;
    const parts: string[] = [];
    if (leg.distanceKm != null) {
      parts.push(`${Math.round(leg.distanceKm)} km`);
      totalKm += leg.distanceKm;
    }
    if (leg.driveTimeMinutes != null) {
      const hrs = Math.floor(leg.driveTimeMinutes / 60);
      const mins = Math.round(leg.driveTimeMinutes % 60);
      parts.push(hrs > 0 ? `~${hrs}h${mins > 0 ? ` ${mins}m` : ''}` : `~${mins}m`);
      totalMinutes += leg.driveTimeMinutes;
    }
    if (parts.length > 0) {
      details += ` (${parts.join(', ')})`;
    }

    dayParts.push(`${label}: ${details}`);
  }

  // Totals line
  const totalParts: string[] = [];
  if (totalKm > 0) totalParts.push(`${Math.round(totalKm)} km`);
  if (totalMinutes > 0) {
    const h = Math.floor(totalMinutes / 60);
    const m = Math.round(totalMinutes % 60);
    totalParts.push(h > 0 ? `~${h}h${m > 0 ? ` ${m}m` : ''} driving` : `~${m}m driving`);
  }
  const totalLine = totalParts.length > 0
    ? `\nTotal: ${totalParts.join(', ')} over ${tripLegs.length} day${tripLegs.length !== 1 ? 's' : ''}`
    : '';

  return dayParts.join(' | ') + totalLine;
}

// ---------------------------------------------------------------------------
// Post-dispatch leg contiguity check
//
// After Penny's tool calls land, verify that consecutive legs chain properly
// (leg N end ≈ leg N+1 start). A gap means Penny deleted a leg without
// updating the neighbor — the map will show a broken route.
// ---------------------------------------------------------------------------
const LEG_GAP_THRESHOLD_KM = 50; // anything >50km between consecutive legs is suspect

async function checkLegContiguity(tripId: string, userId: string): Promise<void> {
  const tripLegs = await db
    .select({
      id: legs.id,
      sortOrder: legs.sortOrder,
      startName: legs.startName,
      endName: legs.endName,
      startLat: legs.startLat,
      startLng: legs.startLng,
      endLat: legs.endLat,
      endLng: legs.endLng,
    })
    .from(legs)
    .where(eq(legs.tripId, tripId))
    .orderBy(legs.sortOrder);

  if (tripLegs.length < 2) return;

  for (let i = 0; i < tripLegs.length - 1; i++) {
    const current = tripLegs[i];
    const next = tripLegs[i + 1];
    if (
      current.endLat == null ||
      current.endLng == null ||
      next.startLat == null ||
      next.startLng == null
    ) {
      continue; // can't check without coords
    }
    const gapKm = haversineKm(
      current.endLat,
      current.endLng,
      next.startLat,
      next.startLng
    );
    if (gapKm > LEG_GAP_THRESHOLD_KM) {
      const msg =
        `Leg contiguity gap on trip ${tripId}: ` +
        `leg ${current.id} ("${current.endName}") → leg ${next.id} ("${next.startName}") ` +
        `gap=${Math.round(gapKm)}km (threshold=${LEG_GAP_THRESHOLD_KM}km). ` +
        `sort_orders: ${current.sortOrder} → ${next.sortOrder}`;
      console.error('[contiguity-check]', msg);
      await logUsageEvent({
        userId,
        tripId,
        provider: 'penny:contiguity-gap',
        requests: 0,
        success: false,
        errorMessage: msg,
      }).catch(() => {});
    }
  }
}

function haversineKm(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ---------------------------------------------------------------------------
// Legacy `changes` envelope shim
//
// The frontend (ChatPanel) reads `data.changes.changes[]` to decide whether
// Penny proposed any changes. Until we update the client, keep emitting the
// pre-existing `{ action, ...flat }` shape so probes like
// `Array.isArray(data?.changes?.changes)` keep working.
// ---------------------------------------------------------------------------
function actionToLegacyChange(action: ValidatedAction): Record<string, unknown> {
  switch (action.name) {
    case 'update_vehicle':
      return { action: 'update_vehicle', data: action.input.data };
    case 'add_leg':
      return { action: 'add_leg', data: action.input };
    case 'delete_leg':
      return { action: 'delete_leg', leg_id: action.input.leg_id };
    case 'update_leg':
      return { action: 'update_leg', leg_id: action.input.leg_id, data: action.input.data };
    case 'add_route':
      return { action: 'add_route', leg_id: action.input.leg_id, data: action.input.data };
    case 'update_route':
      return {
        action: 'update_route',
        route_id: action.input.route_id,
        data: action.input.data,
      };
    case 'delete_route':
      return { action: 'delete_route', route_id: action.input.route_id };
    case 'add_stop':
      return { action: 'add_stop', leg_id: action.input.leg_id, data: action.input.data };
    case 'update_stop':
      return { action: 'update_stop', stop_id: action.input.stop_id, data: action.input.data };
    case 'delete_stop':
      return { action: 'delete_stop', stop_id: action.input.stop_id };
    case 'plan_fuel_stops':
      return { action: 'plan_fuel_stops', leg_id: action.input.leg_id };
    case 'add_task':
      return {
        action: 'add_task',
        leg_id: action.input.leg_id ?? null,
        data: action.input.data,
      };
    case 'update_task':
      return { action: 'update_task', task_id: action.input.task_id, data: action.input.data };
  }
}
