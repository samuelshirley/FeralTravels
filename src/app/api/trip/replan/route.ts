import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';
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

/** One POST /api/trip/replan: queue `add_leg` ids so `plan_fuel_stops` can recover from guessed leg_id. */
type ReplanDispatchCtx = { newLegIdsQueue: number[] };

function assertLegOnTrip(legTripId: number, tripId: number): void {
  if (legTripId !== tripId) throw new ForbiddenError('Leg is not part of this trip');
}

async function getLatestLegIdOnTrip(targetTripId: number): Promise<number | null> {
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
 * Claude sometimes echoes `sort_order` (small integers like 2, 3), ids from stale
 * context, or guesses before sibling `add_leg` rows exist. We validate with
 * ownership + trip containment first; then try matching `sort_order` on `tripId`
 * uniquely; lastly (when opts allow) we fall back like `plan_fuel_stops`:
 * dequeue an id persisted earlier in this same dispatch batch.
 */
async function resolvePennyLegIdOnTrip(
  proposedLegId: number,
  tripId: number,
  userId: string,
  ctx: ReplanDispatchCtx,
  opts?: { dequeueNewLegFallback?: boolean }
): Promise<number> {
  async function resolveLeg(candidate: number): Promise<void> {
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

    const sortedByOrder = await db
      .select({ id: legs.id })
      .from(legs)
      .where(and(eq(legs.tripId, tripId), eq(legs.sortOrder, proposedLegId)))
      .limit(2);

    if (sortedByOrder.length === 1) {
      const candidate = sortedByOrder[0]!.id;
      await resolveLeg(candidate);
      return candidate;
    }

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

/** add_stop heel: peek latest queued/new leg rather than dequeue (see caller). */
async function resolvePennyStopLegId(
  proposedLegId: number,
  tripId: number,
  userId: string,
  ctx: ReplanDispatchCtx
): Promise<number> {
  async function legMustBelongToThisTrip(candidate: number): Promise<void> {
    const ownerTripId = await assertLegOwnedByUser(candidate, userId);
    assertLegOnTrip(ownerTripId, tripId);
  }

  try {
    await legMustBelongToThisTrip(proposedLegId);
    return proposedLegId;
  } catch (e) {
    const wrongTrip =
      e instanceof ForbiddenError && e.message === 'Leg is not part of this trip';
    if (!(e instanceof NotFoundError) && !wrongTrip) throw e;

    const queued =
      ctx.newLegIdsQueue.length > 0
        ? ctx.newLegIdsQueue[ctx.newLegIdsQueue.length - 1]
        : null;
    const latestOnTrip =
      queued == null ? await getLatestLegIdOnTrip(tripId) : null;
    const fallback = queued ?? latestOnTrip ?? null;

    if (fallback == null) throw e;

    await legMustBelongToThisTrip(fallback);
    return fallback;
  }
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
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (e: Record<string, unknown>) => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
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
            }
          }

          const fuelReplenishQueued = appliedActions.some(
            actionShouldTriggerTripFuelReplenish
          );

          const changesEnvelope = {
            changes: appliedActions.map(actionToLegacyChange),
          };

          const validatedQueuedCount = final.validatedActions.length;

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
          controller.close();
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
