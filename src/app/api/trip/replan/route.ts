import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '@/server/db/client';
import { legs, costs } from '@/server/db/schema';
import { replan } from '@/lib/claude';
import type { ValidatedAction } from '@/lib/penny/tools';
import {
  requireUserId,
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

/** One POST /api/trip/replan: queue `add_leg` ids so `plan_fuel_stops` can recover from guessed leg_id. */
type ReplanDispatchCtx = { newLegIdsQueue: number[] };

function assertLegOnTrip(legTripId: number, tripId: number): void {
  if (legTripId !== tripId) throw new ForbiddenError('Leg is not part of this trip');
}

async function assertPlanFuelLegOwnedOnTrip(
  legId: number,
  tripId: number,
  userId: string
): Promise<void> {
  const legTripId = await assertLegOwnedByUser(legId, userId);
  assertLegOnTrip(legTripId, tripId);
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
  tripId: z.number().int().positive(),
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
  let tripIdForLog: number | null = null;
  /** After the user bubble is persisted; used to add an assistant error bubble on fatal throw. */
  let userTurnSaved = false;
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
    userTurnSaved = true;
    const result = await replan(message, tripId, images, userId);

    // Truncation = Penny hit MAX_TOOL_USE_ITERATIONS mid-plan and exited
    // with partial work persisted. Log it so we can watch how often this
    // happens after the iteration bump + parallel-batching prompt change.
    // Fire-and-forget — never let a logging error fail the response.
    if (result.truncated) {
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
    let failedCount = 0;
    const failedActions: Array<{ action: string; error: string }> = [];
    const appliedActions: ValidatedAction[] = [];

    // Validation failures from inside the tool-use loop (Penny couldn't
    // produce a valid call after MAX_VALIDATION_RETRIES) get surfaced to
    // the user the same way as repo-layer failures below.
    for (const v of result.failedValidations) {
      failedCount += 1;
      failedActions.push({ action: v.tool, error: v.error });
    }

    // Feasibility gate (server-side belt for the prompt rule's suspenders).
    //
    // If extract_trip_intent was called this turn, this is a fresh plan or
    // significant scope change — Penny was required to call
    // check_trip_feasibility. If that didn't happen, or it returned
    // 'over_budget', we refuse to apply any add_leg actions. Other action
    // types (add_stop, update_route, plan_fuel_stops, etc.) flow through
    // unaffected — the gate is specific to leg creation, since legs are
    // what determines the day count the budget gates against.
    //
    // Tweaks (no extract_trip_intent in this turn) bypass the gate entirely.
    // That preserves the "move leg 3 a day later" / "add a fuel stop" UX.
    const feasibilityGateActive = result.extractIntentCalled;
    const feasibilityGateBlocks =
      feasibilityGateActive &&
      (result.feasibilityVerdict === null ||
        result.feasibilityVerdict === 'over_budget');

    // Dispatch every validated action. The discriminated union on
    // `action.name` narrows `action.input` to its exact shape — no manual
    // narrowing or coercion needed (the Zod validators already did that work
    // inside the tool-use loop).
    const dispatchCtx: ReplanDispatchCtx = { newLegIdsQueue: [] };
    for (const action of result.validatedActions) {
      // Reject add_leg when the feasibility gate is blocking. We surface
      // this as a per-action failure so the chat shows a clear error,
      // similar to validator failures. Penny's text response (which
      // should already explain the over-budget situation per the prompt
      // rule) is shown to the user alongside.
      if (feasibilityGateBlocks && action.name === 'add_leg') {
        failedCount += 1;
        failedActions.push({
          action: 'add_leg',
          error:
            result.feasibilityVerdict === 'over_budget'
              ? 'Plan rejected — exceeds your time budget. Penny should have asked you to extend the trip or drop a stop before saving.'
              : 'Plan rejected — Penny did not run the feasibility check before saving. Ask her to retry the plan.',
        });
        continue;
      }
      try {
        await dispatchAction(action, tripId, userId, dispatchCtx);
        appliedActions.push(action);
        appliedCount += 1;
      } catch (e) {
        failedCount += 1;
        const msg = e instanceof Error ? e.message : String(e);
        failedActions.push({ action: action.name, error: msg });
        console.error('Failed to apply validated action', action, e);
      }
    }

    const fuelReplenishQueued = appliedActions.some(actionShouldTriggerTripFuelReplenish);

    // Rebuild a `changes` envelope in the legacy shape so the existing
    // frontend (ChatPanel) keeps working without a schema migration. Each
    // entry mirrors the old `{ action, ...flat }` shape so
    // `data.changes.changes` array probing still works on the client.
    const changesEnvelope = {
      changes: result.validatedActions.map(actionToLegacyChange),
    };

    const assistantChangesMade =
      appliedCount > 0 ? JSON.stringify(changesEnvelope) : null;
    await addChatMessage(tripId, 'assistant', result.response, assistantChangesMade);

    return Response.json({
      response: result.response,
      changes: changesEnvelope,
      appliedCount,
      failedCount,
      failedActions,
      fuelReplenishQueued,
      // Diagnostics — surfaced for the admin log + future client UX. The
      // client currently ignores these but they're cheap to send.
      retryCount: result.retryCount,
      truncated: result.truncated,
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
  tripId: number,
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

      let vehicleId: number | null = trip.vehicle_id ?? null;
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
      });
      ctx.newLegIdsQueue.push(newLegId);
      return;
    }

    case 'delete_leg': {
      await assertLegOwnedByUser(action.input.leg_id, userId);
      await deleteLeg(action.input.leg_id);
      return;
    }

    case 'update_leg': {
      const { leg_id, data } = action.input;
      await assertLegOwnedByUser(leg_id, userId);

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
      const { leg_id, data } = action.input;
      await assertLegOwnedByUser(leg_id, userId);
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
      const { leg_id, data } = action.input;
      await assertLegOwnedByUser(leg_id, userId);
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
      const requested = action.input.leg_id;
      try {
        await assertPlanFuelLegOwnedOnTrip(requested, tripId, userId);
      } catch (e) {
        if (!(e instanceof NotFoundError) || ctx.newLegIdsQueue.length === 0) throw e;
        const fallback = ctx.newLegIdsQueue.shift()!;
        try {
          await assertPlanFuelLegOwnedOnTrip(fallback, tripId, userId);
        } catch (e2) {
          ctx.newLegIdsQueue.unshift(fallback);
          throw e2;
        }
      }
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
