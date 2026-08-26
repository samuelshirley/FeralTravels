import { z } from 'zod';
import { desc, eq } from 'drizzle-orm';
import { db } from '@/server/db/client';
import { legs, costs, trips } from '@/server/db/schema';
import { replanStream, type ReplanEvent } from '@/lib/claude';
import type { ReplanResult } from '@/lib/claude';
import type { ValidatedAction } from '@/lib/penny/tools';
import { restLegBlockedFields, restLegEditRejectionMessage } from '@/lib/penny/tools/updateLeg';
import {
  requireEntitledUser,
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
import {
  createTurn,
  getTurnByKey,
  promoteTurnToRunning,
  claimNextQueuedTurn,
  markTurnDone,
  markTurnError,
  type PennyTurnImage,
} from '@/server/repos/pennyTurns';
import { addRoute, updateRoute, deleteRoute } from '@/server/repos/routes';
import { addStop, deleteStop, updateStop, getStop } from '@/server/repos/stops';
import { addTask, updateTask, getLegTripId } from '@/server/repos/tasks';
import { addLeg, deleteLeg, getTripFull, assertTripNameAvailable, addLegConstraint, rebuildTripSchedule, repairLegContinuity, rerouteLeg, autoNameTripFromSeason, applyTripProgress } from '@/server/repos/trips';
import { updateVehicle, getVehicleForUser, getDefaultVehicleForUser } from '@/server/repos/vehicles';
import { getUserUsageSummary, microcentsToDollars, logUsageEvent } from '@/server/repos/usage';
import { getDirections } from '@/lib/google/directions';
import { invalidateLegFuelCache } from '@/server/fuel';
import { tryParseToISO } from '@/lib/dates';
import { computePlanSummary } from '@/lib/penny/planSummary';
import { countQueuedMutations } from '@/lib/penny/applyOutcome';
import { pickNearestNewLeg, type NewLegRecord } from '@/lib/penny/newLegFallback';
import { findGapCreatingDeletes, LEG_GAP_THRESHOLD_KM } from '@/lib/penny/contiguityGate';
import {
  detectOverriddenLegEdits,
  overriddenEditsSummary,
  type OverriddenEdit,
  type OverrideCheckAction,
} from '@/lib/penny/editOverride';
import type { PlanSummary } from '@/types/trip';
import type { GeoJSONLineString } from '@/server/db/schema';

/**
 * Per-request dispatch state for one POST /api/trip/replan.
 *
 * - `newLegIdsQueue`: consuming FIFO of `add_leg` ids, dequeued by the
 *   single-leg recovery fallback (`plan_fuel_stops`, `update_leg`,
 *   `plan_dump_station_stops`) when Penny guesses a leg_id before its row exists.
 * - `newLegs`: append-only record of every leg created this turn, WITH coords,
 *   used by the non-consuming `add_stop`/`add_route` fallback so a stop lands on
 *   the right same-turn leg (several stops may share one leg).
 */
type ReplanDispatchCtx = { newLegIdsQueue: string[]; newLegs: NewLegRecord[] };

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
 * Resolve the leg an `add_stop` / `add_route` action belongs to.
 *
 * Happy path: the proposed id is a real leg on this trip — return it.
 *
 * Fallback: the proposed id doesn't resolve because the item targets a leg
 * Penny CREATED earlier in this same turn. New legs are written only at
 * dispatch time, so Penny never saw their real UUID during the model loop and
 * invented one. We map that invented id onto a real new leg — geometry-first
 * (nearest new-leg corridor to the item's coordinate), else the first leg
 * created this turn. NON-consuming: several stops can share one new leg.
 *
 * Before this existed, `add_stop`/`add_route` on a same-turn leg threw
 * "Leg not found" and the action was silently dropped while the leg itself
 * saved — so Penny would promise a waypoint that never landed on the map. The
 * sibling actions (`update_leg`, `plan_dump_station_stops`) already had a
 * same-turn fallback; these two were the stragglers.
 */
async function resolveLegForStopOrRoute(
  proposedLegId: string,
  point: { lat?: number | null; lng?: number | null } | null,
  tripId: string,
  userId: string,
  ctx: ReplanDispatchCtx
): Promise<string> {
  try {
    const ownerTripId = await assertLegOwnedByUser(proposedLegId, userId);
    assertLegOnTrip(ownerTripId, tripId);
    return proposedLegId;
  } catch (e) {
    const wrongTrip =
      e instanceof ForbiddenError && e.message === 'Leg is not part of this trip';
    if (!(e instanceof NotFoundError) && !wrongTrip) throw e;

    const fallbackLegId = pickNearestNewLeg(point, ctx.newLegs);
    if (fallbackLegId != null) return fallbackLegId;

    // No leg was created this turn — the id is genuinely bogus. Surface it.
    throw e;
  }
}

/**
 * Whether an applied action changes the schedule SHAPE — i.e. the day/leg
 * structure or the trip's anchor date — such that the deterministic plan
 * summary should be recomputed and snapshotted onto this turn. Pure stop/task
 * tweaks don't move dates or day counts, so they don't trigger a fresh summary.
 */
function actionAffectsScheduleSummary(action: ValidatedAction): boolean {
  return (
    action.name === 'add_leg' ||
    action.name === 'update_leg' ||
    action.name === 'delete_leg' ||
    action.name === 'rename_trip' || // can change start_date → shifts every leg's date
    action.name === 'report_position' // re-anchors the calendar from current progress
  );
}

// Per-user spend cap and request cap on Anthropic replans.
// Update via env at any time.
//
// The hourly request cap is set generously for pre-launch (120) so test users
// aren't tripped by the 429 during heavy iteration; the $5/day spend cap is the
// real cost backstop. Admins (Sam) are already exempt from both (see admin.ts).
// Note: server-side auto-continue (claude.ts) chains long plans WITHIN a single
// replan request, so a continued plan does NOT consume extra hourly requests.
const REPLAN_USD_CAP_PER_DAY = parseFloat(process.env.REPLAN_USD_CAP_PER_DAY || '5');
const REPLAN_REQUESTS_PER_HOUR = parseInt(process.env.REPLAN_REQUESTS_PER_HOUR || '120', 10);

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
  /**
   * Client-generated stable id for THIS send (one per user action). It is the
   * idempotency anchor for the durable `penny_turns` record: a retry or
   * double-send carrying the same key returns the existing turn instead of
   * spawning a second concurrent replan. Optional so older clients still work
   * (the server mints one), but then idempotency degrades to best-effort.
   */
  idempotencyKey: z.string().min(8).max(100).optional(),
});

/**
 * Wall-clock budget for the Penny model loop. Sits below the function's
 * `maxDuration` (300s) so we surface an honest "timed out" error to the user
 * BEFORE the platform hard-kills the request — which otherwise dropped the SSE
 * stream with no error event, leaving the user with a bare "something went
 * wrong". Leaves headroom for the post-loop dispatch + flush.
 */
const MODEL_LOOP_BUDGET_MS = 280_000;

/**
 * Turn any thrown error into a concise, user-facing chat line. We surface the
 * real message (first line, truncated) instead of a blanket generic string —
 * the repo convention is to never silently swallow errors, and the user
 * explicitly needs to see what failed. Falls back to a generic line only when
 * there's genuinely no message.
 */
function userFacingError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const first = raw.split('\n')[0]?.slice(0, 200).trim() ?? '';
  return first
    ? `Penny hit an error: ${first}`
    : 'Something went wrong while updating your trip. Please try again.';
}

export async function POST(req: Request) {
  // Hoisted so the catch can attribute the failure to the right user/trip in
  // usage_events even when the failure happens mid-Anthropic-call.
  let userIdForLog: string | null = null;
  let tripIdForLog: string | null = null;
  /** After the user bubble is persisted; used to add an assistant error bubble on fatal throw. */
  let userTurnSaved = false;
  try {
    // requireEntitledUser, not requireUser: this is the route that spends
    // Anthropic money, so it is the one the paywall exists for. It throws a
    // 402 carrying `code`/`state`/`blockReason`, which both clients branch on
    // to render Penny's paywall message instead of a red error bubble.
    const { id: userId, isAdmin: isAdminUser } = await requireEntitledUser();
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

    // Durable turn record — the idempotency + concurrency + re-attach anchor.
    // See docs/design/penny-turn-resilience.md.
    const idempotencyKey = body.idempotencyKey ?? crypto.randomUUID();
    const turnImages: PennyTurnImage[] = images;

    // Idempotent replay: this exact send was already accepted. Don't run it
    // again — hand back the existing record so the client can apply its result
    // (done/error) or keep polling until it lands (running/queued). This is the
    // guard against a "Please try again" double-send spawning a second replan.
    const existingTurn = await getTurnByKey(idempotencyKey);
    if (existingTurn) {
      return Response.json({ turn: existingTurn });
    }

    // Create the turn as `queued` (deduped on idempotency key). An identical
    // concurrent send that lost the insert race comes back as a replay.
    const { turn: queuedTurn, created } = await createTurn({
      tripId,
      userId,
      idempotencyKey,
      userMessage: message || '(image only)',
      images: turnImages,
    });
    if (!created) {
      return Response.json({ turn: queuedTurn });
    }

    // Persist the user's bubble now so it shows in chat order immediately,
    // whether we run this turn now or queue it.
    await addChatMessage(tripId, 'user', message || '(image only)');
    userTurnSaved = true;

    // Claim the trip's single execution slot. The partial unique index
    // (`penny_turns_one_running_per_trip_idx`) makes this ATOMIC: if another
    // turn is already running, promotion returns null and this turn stays
    // queued — the running request drains it when it finishes. Two distinct
    // concurrent sends can never both start a replan on one trip.
    const turn = await promoteTurnToRunning(queuedTurn.id);
    if (!turn) {
      return Response.json({ turn: queuedTurn });
    }

    // Running: stream Penny's progress so the user sees each paragraph as it
    // lands instead of the whole turn buffering for ~10-30s. Format is plain
    // Server-Sent Events: each event is a single `data: <json>\n\n` frame. The
    // terminal `applied` event carries the same shape the client already
    // parses. After this turn completes we drain any turns that queued behind
    // it — still inside this alive request — before closing the stream.
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
          // Execute THIS turn (streams to the live client), then drain any
          // turns that queued behind it while it ran — all inside this
          // still-alive request, so a queued turn completes even after the
          // original client closes (the function isn't cancelled on disconnect:
          // there's no vercel.json supportsCancellation flag).
          await runTurnWork(
            { turnId: turn.id, tripId, userId, message, images: turnImages },
            send,
          );
          await drainQueuedTurns(tripId);
        } catch (orchestrationErr) {
          // Per-turn errors are handled inside runTurnWork / drainQueuedTurns
          // (persisted bubble + markTurnError + an SSE `error` event). This
          // guards only an unexpected orchestration throw so the stream still
          // closes cleanly.
          console.error('replan stream orchestration failed', orchestrationErr);
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
        userFacingError(err),
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

/**
 * Execute one Penny replan turn: run the model loop, dispatch validated
 * actions, persist Penny's reply, and record the durable outcome on the turn's
 * `penny_turns` row (`done`/`error`). `send` streams SSE events to a live
 * client for the foreground turn; for a queued turn drained in the background
 * it's a no-op — the result is read back later via the reconcile endpoint.
 *
 * Self-contained error handling: any throw is caught here, persisted as a chat
 * bubble (real message, survives reload), logged to usage_events, marked on the
 * turn row, and emitted as an SSE `error`. This never rethrows.
 */
async function runTurnWork(
  ctx: {
    turnId: string;
    tripId: string;
    userId: string;
    message: string;
    images: PennyTurnImage[];
  },
  send: (e: Record<string, unknown>) => void
): Promise<void> {
  const { turnId, tripId, userId, message, images } = ctx;
  try {
    // Message lifecycle events for the chat UX. `received` fires
    // right after the user message is persisted (≈ "delivered"),
    // and `reading` fires before we call Claude (≈ "read / typing").
    send({ kind: 'received' });
    send({ kind: 'reading' });

    // Consume the model loop, returning the terminal ReplanResult. Raced
    // against a wall-clock budget so a pathologically long turn surfaces a
    // real "timed out" error instead of being silently killed by the
    // platform mid-stream. The closure returns its result (rather than
    // writing an outer `let`) so it stays correctly typed through the race.
    const consume = async (): Promise<ReplanResult | null> => {
      let result: ReplanResult | null = null;
      for await (const ev of replanStream(message, tripId, images, userId)) {
        if (ev.kind === 'done') {
          result = ev.result;
          continue;
        }
        send(ev satisfies ReplanEvent);
      }
      return result;
    };
    const final = await Promise.race([
      consume(),
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                'Penny timed out before finishing — the request was too complex to complete in time. Try breaking it into smaller steps.',
              ),
            ),
          MODEL_LOOP_BUDGET_MS,
        ),
      ),
    ]);

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

          // Penny serialized a tool call as plain text instead of invoking it.
          // We caught it and gave one corrective turn; record how often this
          // happens and whether the retry recovered it (success=true) or the
          // leak persisted and had to be sanitized (success=false — the action
          // most likely never ran). Shows up in /admin/errors when not recovered.
          if (final.leakRetryCount > 0) {
            const recovered = !final.leakSanitized;
            logUsageEvent({
              userId,
              tripId,
              provider: 'penny:tool-call-leak',
              requests: 0,
              success: recovered,
              errorMessage: `Penny emitted tool-call markup as text; retried=${final.leakRetryCount}; recovered=${recovered}`,
            }).catch((e) => console.warn('logUsageEvent (tool-call-leak) failed:', e));
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
          // reject any delete_leg that would leave a NEW gap in the route
          // (pre-existing gaps don't count — see lib/penny/contiguityGate.ts).
          // Penny sometimes deletes a leg without updating the neighbor to
          // close the gap, leaving a hole in the map.
          const gateLegs = await db
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
          const blockedDeleteLegIds = findGapCreatingDeletes(
            gateLegs,
            final.validatedActions
          );

          const dispatchCtx: ReplanDispatchCtx = { newLegIdsQueue: [], newLegs: [] };
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
              // submit_idea is a side-effect log, not a trip mutation — don't
              // count it as an applied change so it doesn't trigger the "Changes
              // applied to trip" banner or a schedule/fuel recompute.
              if (action.name !== 'submit_idea') {
                appliedActions.push(action);
                appliedCount += 1;
              }
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

          // Deterministic schedule rebuild. Now that drive legs + constraints are
          // persisted, the server takes ownership of rest-day count + leg ordering
          // so the calendar dates match what the user asked for — Penny can't
          // miscount rest days or strand one after the wrong drive. Best-effort:
          // the legs are already saved, so a rebuild failure must never break the
          // response. Runs before the contiguity check + route summary so both
          // see the corrected order.
          if (appliedCount > 0) {
            try {
              const infeasibleDates = await rebuildTripSchedule(tripId);
              for (const inf of infeasibleDates) {
                logUsageEvent({
                  userId,
                  tripId,
                  provider: 'penny:schedule-infeasible',
                  requests: 0,
                  success: false,
                  errorMessage: `Fixed date ${inf.anchorDateISO} unreachable (leg ${inf.legId}): ${inf.reason}`,
                }).catch(() => {});
              }
            } catch (e) {
              console.error('[schedule-rebuild] failed', e);
              logUsageEvent({
                userId,
                tripId,
                provider: 'penny:schedule-rebuild-failed',
                requests: 0,
                success: false,
                errorMessage: e instanceof Error ? e.message : String(e),
              }).catch(() => {});
            }
          }

          // Deterministic continuity repair. After the schedule is settled, force
          // every leg to start where the previous one ended — chaining the route
          // so Penny can never leave a "magic jump" (a leg whose origin is the
          // wrong place). Re-routes any corrected leg so the plan totals stay
          // honest. Runs before the contiguity check (now a safety net) and the
          // plan-summary computation so both see the repaired legs. Best-effort:
          // the legs are already saved, so a repair failure must never break the
          // response.
          if (appliedCount > 0) {
            try {
              const repaired = await repairLegContinuity(tripId);
              for (const r of repaired) {
                // A repaired leg had its start chained (and usually re-routed),
                // so its cached fuel plan is stale. Invalidate that leg's fuel
                // cache so it re-sources lazily on next open — affected legs
                // only, never a trip-wide re-fan-out.
                await invalidateLegFuelCache(r.legId).catch((e) =>
                  console.warn('[continuity-repair] fuel cache invalidation failed', e)
                );
                logUsageEvent({
                  userId,
                  tripId,
                  provider: r.rerouted
                    ? 'penny:continuity-repaired'
                    : 'penny:continuity-repaired-noroute',
                  requests: 0,
                  success: r.rerouted,
                  errorMessage:
                    `Leg ${r.legId} start chained "${r.fromName ?? '?'}" → "${r.toName ?? '?'}"` +
                    (r.rerouted ? '' : ' (re-route failed — distance/time/geometry cleared)'),
                }).catch(() => {});
              }
            } catch (e) {
              console.error('[continuity-repair] failed', e);
              logUsageEvent({
                userId,
                tripId,
                provider: 'penny:continuity-repair-failed',
                requests: 0,
                success: false,
                errorMessage: e instanceof Error ? e.message : String(e),
              }).catch(() => {});
            }
          }

          // Post-dispatch leg contiguity check: a safety net that detects any gap
          // the repair above could not close (e.g. missing coords). Log so it
          // shows up in admin errors — don't block the response.
          if (appliedCount > 0) {
            checkLegContiguity(tripId, userId).catch((e) =>
              console.warn('[contiguity-check] failed', e)
            );
          }

          // Edit-override detection: did the pipeline (rebuild + repair) rewrite
          // a leg Penny JUST edited? Her prose streamed before dispatch, so an
          // overridden edit means the transcript claims something the plan no
          // longer contains (the "campsite near Alset" bug: a rest-day edit was
          // re-materialized back to Trondheim while her reply said the campsite
          // was saved). Detect, log for /admin/errors, and pass to the client
          // so the bubble carries a warning. Best-effort — never block the turn.
          let overriddenEdits: OverriddenEdit[] = [];
          if (appliedCount > 0) {
            try {
              const editedLegActions = appliedActions.filter((a) => a.name === 'update_leg');
              if (editedLegActions.length > 0) {
                const settledLegs = await db
                  .select({
                    id: legs.id,
                    title: legs.title,
                    startName: legs.startName,
                    endName: legs.endName,
                    startLat: legs.startLat,
                    startLng: legs.startLng,
                    endLat: legs.endLat,
                    endLng: legs.endLng,
                  })
                  .from(legs)
                  .where(eq(legs.tripId, tripId));
                overriddenEdits = detectOverriddenLegEdits(
                  editedLegActions as unknown as OverrideCheckAction[],
                  settledLegs
                );
                if (overriddenEdits.length > 0) {
                  logUsageEvent({
                    userId,
                    tripId,
                    provider: 'penny:edit-overridden',
                    requests: 0,
                    success: false,
                    errorMessage: overriddenEditsSummary(overriddenEdits).slice(0, 500),
                  }).catch(() => {});
                }
              }
            } catch (e) {
              console.warn('[edit-override] detection failed', e);
            }
          }

          // Lazy fuel: we no longer fan out a trip-wide fuel replan on leg
          // edits — that eager fan-out was the Google Places cost sink. Each
          // day now sources its own fuel lazily on open, and leg edits below
          // invalidate only the affected leg's cache. The single thing the
          // client still must react to is an inline plan_fuel_stops lookup
          // (Penny ran the planner on an EXPLICIT ask and wrote stops to a
          // leg): reload the trip so those stops render. `final.fuelPlanRan`
          // carries that from the stream.
          const fuelStopsChanged = final.fuelPlanRan;

          const changesEnvelope = {
            changes: appliedActions.map(actionToLegacyChange),
          };

          // Mutations only — submit_idea is excluded (it's a side-effect log,
          // never counted as applied; counting it as "queued" here made every
          // submit_idea-only turn render the false red "nothing was saved"
          // banner). See countQueuedMutations in lib/penny/applyOutcome.ts.
          const validatedQueuedCount = countQueuedMutations(final.validatedActions);

          // Deterministic, DB-derived plan summary — the source of truth for the
          // plan FACTS the user sees (day counts, depart/arrive dates, totals,
          // deadline check). Computed from the legs AFTER they land and the
          // schedule rebuild runs, so it reflects what was actually saved, not
          // Penny's autoregressive prose (which invented arrival times and
          // miscounted nights). Only attach it on turns that changed the
          // schedule shape — small stop/task tweaks don't re-render the summary.
          let planSummary: PlanSummary | null = null;
          if (appliedActions.some(actionAffectsScheduleSummary)) {
            try {
              const trip = await getTripFull(tripId);
              if (trip) {
                planSummary = computePlanSummary({
                  legs: trip.legs,
                  tripStartISO: trip.start_date_parsed,
                });
              }
            } catch (e) {
              console.warn('[plan-summary] failed to build', e);
            }
          }

          const assistantChangesMade =
            appliedCount > 0 ? JSON.stringify(changesEnvelope) : null;
          // Honest transcript: Penny's prose streams BEFORE dispatch, so when
          // every queued change is then rejected her already-streamed "Done —
          // ..." is a lie the transcript would otherwise keep forever (real
          // incident: 36/36 delete_legs blocked, message still said the legs
          // were cleared). Append a server-authored correction so the
          // persisted message — and the payload the client/heal path renders —
          // matches what actually happened.
          let persistedResponse = final.response;
          if (validatedQueuedCount > 0 && appliedCount === 0 && persistFailedCount > 0) {
            const firstError = persistFailedActions[0]?.error ?? 'unknown error';
            persistedResponse +=
              `\n\n⚠️ Correction: none of these changes could be saved — ` +
              `the app rejected them (${firstError}). Your plan is unchanged.`;
          }
          await addChatMessage(
            tripId,
            'assistant',
            persistedResponse,
            assistantChangesMade,
            'ai',
            planSummary,
          );

          // Terminal event. Same shape as the old JSON response so the
          // client doesn't need two parsers. `failedCount`/`failedActions`
          // remain the merged total (validation + persist) for ops/logging;
          // user-facing banners should use `persistFailed*` only.
          // Terminal payload. Same shape the client already parses for the live
          // stream AND the durable record it reads back on reconcile, so heal
          // and live-apply share one code path. `failedCount`/`failedActions`
          // stay the merged total (validation + persist) for ops/logging;
          // user-facing banners use `persistFailed*` only.
          const appliedPayload = {
            response: persistedResponse,
            changes: changesEnvelope,
            appliedCount,
            failedCount,
            failedActions,
            persistFailedCount,
            persistFailedActions,
            validationFailures,
            /** Count of Penny actions that validated and queued for dispatch (incl. failed persist). */
            validatedQueuedCount,
            /** update_leg edits the deterministic pipeline rewrote after they landed (see lib/penny/editOverride.ts). */
            overriddenEdits,
            fuelStopsChanged,
            planSummary,
            retryCount: final.retryCount,
            truncated: final.truncated,
          };
          send({ kind: 'applied', ...appliedPayload });

          // Durable success: record the outcome on the turn row so a client
          // that dropped the stream (PWA backgrounded mid-turn) can re-attach
          // and apply it — healing the false "Something went wrong" bubble —
          // via the reconcile endpoint.
          await markTurnDone(turnId, {
            resultResponse: final.response,
            resultMeta: appliedPayload,
          });
  } catch (err) {
    console.error('runTurnWork failed', err);
    // Best-effort: surface a chat bubble so the user knows the turn failed —
    // with the REAL error, not a generic line (so it survives a reload and the
    // user can act on it).
    await addChatMessage(
      tripId,
      'assistant',
      userFacingError(err),
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
    // Record the failure on the turn row so a reconciling client shows the real
    // error instead of dead-ending on the client-only "try again" bubble.
    await markTurnError(
      turnId,
      err instanceof Error ? err.message : String(err)
    ).catch(() => {});
    send({
      kind: 'error',
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Upper bound on queued turns drained within a single request, so a
 * pathological backlog can't run unbounded inside one invocation. Anything
 * beyond this stays `queued` and is picked up by the next turn's drain.
 */
const MAX_DRAIN_TURNS = 5;

/**
 * Run turns that queued behind the just-finished foreground turn — serially,
 * inside the still-alive request. Each claim is atomic (the status guard in the
 * UPDATE), so concurrent drainers never run the same turn twice. A drained turn
 * streams to nobody: its reply is persisted to chat + its `penny_turns` row,
 * and the originating client reads it back via the reconcile endpoint. This is
 * what lets a send fired while another was in flight survive the app closing.
 */
async function drainQueuedTurns(tripId: string): Promise<void> {
  for (let i = 0; i < MAX_DRAIN_TURNS; i++) {
    const claimed = await claimNextQueuedTurn(tripId);
    if (!claimed) return;
    await runTurnWork(
      {
        turnId: claimed.id,
        tripId: claimed.trip_id,
        userId: claimed.user_id,
        message: claimed.user_message,
        images: claimed.images ?? [],
      },
      () => {}
    );
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

      // LOCKED DOWN (2026-07-02): the update_vehicle tool carries fuel_type
      // ONLY. The range field (range_km) is a
      // safety number writable only via onboarding + Settings — never chat.
      // Build the patch explicitly (not a spread) so a widened tool schema
      // can never smuggle extra columns into the vehicle row.
      const vehiclePatch: Record<string, unknown> = {
        fuel_type: action.input.data.fuel_type,
      };

      const updated = await updateVehicle(userId, vehicleId, vehiclePatch);
      if (!updated) throw new NotFoundError('Vehicle not found or not owned by user');
      return;
    }

    case 'rename_trip': {
      const tripUpdate: Record<string, unknown> = {
        updatedAt: new Date(),
      };
      // `name` is optional: present only when (re)naming. Omitting it on a
      // date-only update preserves the existing name instead of clobbering it.
      if (action.input.name !== undefined) {
        await assertTripNameAvailable(userId, action.input.name, tripId);
        tripUpdate.name = action.input.name;
      }
      if (action.input.start_date !== undefined) {
        // Only update the machine date when the new value parses — never clear
        // start_date_parsed (hard non-null invariant). Keep the free-text update
        // regardless so the user's phrasing is preserved.
        tripUpdate.startDate = action.input.start_date;
        const parsedStart = tryParseToISO(action.input.start_date);
        if (parsedStart) tripUpdate.startDateParsed = parsedStart;
      }
      if (action.input.end_date !== undefined) {
        tripUpdate.endDate = action.input.end_date;
        tripUpdate.endDateParsed = tryParseToISO(action.input.end_date);
      }
      await db
        .update(trips)
        .set(tripUpdate)
        .where(eq(trips.id, tripId));
      // Auto-name the trip from its season/dates once a start date exists —
      // a no-op unless the trip still carries the "New trip" placeholder.
      await autoNameTripFromSeason(tripId, userId);
      return;
    }

    case 'submit_idea': {
      // Durable, readable sink for user feature ideas — logged to usage_events
      // (the app's notable-event log) so the team can read them later. NOT a
      // trip mutation; this makes Penny's "I've passed it to the team" truthful.
      await logUsageEvent({
        userId,
        tripId,
        provider: 'penny:user-idea',
        requests: 0,
        success: true,
        errorMessage:
          (action.input.area ? `[${action.input.area}] ` : '') + action.input.idea,
      });
      return;
    }

    case 'report_position': {
      const d = action.input;
      const progress = await applyTripProgress({
        tripId,
        lat: d.lat,
        lng: d.lng,
        placeName: d.place_name ?? null,
        nextLegId: d.next_leg_id ?? null,
        resumeDateISO: d.resume_date ?? null,
      });
      // Reporting position re-points + re-routes the upcoming drive leg, so its
      // cached fuel plan (computed for the old start) is now stale. Invalidate
      // THAT leg only — it re-sources lazily when the driver opens it. We never
      // re-fan-out the whole trip (the old eager behaviour / cost sink).
      if (progress.reroutedLeg && progress.currentLegId) {
        await invalidateLegFuelCache(progress.currentLegId);
      }
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
        legType: d.leg_type ?? 'drive',
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
        afterLegId: d.after_leg_id ?? null,
        segmentIndex: d.segment_index ?? null,
        segmentName: d.segment_name ?? null,
        geometry,
      });
      ctx.newLegIdsQueue.push(newLegId);
      ctx.newLegs.push({
        id: newLegId,
        startLat: d.start_lat ?? null,
        startLng: d.start_lng ?? null,
        endLat: d.end_lat ?? null,
        endLng: d.end_lng ?? null,
      });

      // Write any constraints Penny attached to this leg
      if (d.constraints && d.constraints.length > 0) {
        for (const c of d.constraints) {
          await addLegConstraint({
            legId: newLegId,
            constraintType: c.constraint_type,
            constraintDatetime: c.datetime ?? null,
            bufferMinutes: c.buffer_minutes ?? 60,
            note: c.note ?? null,
          });
        }
      }
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

      // Rest-leg guard (apply-time). The validator already rejects this
      // in-loop when the leg was in Penny's context snapshot; this covers the
      // stale-context / remapped-id paths. Without it, rebuildTripSchedule
      // silently reverts the location edit seconds after we persist it while
      // Penny's prose claims it saved (the "campsite near Alset" bug).
      const existingRows = await db.select().from(legs).where(eq(legs.id, leg_id)).limit(1);
      const existingLeg = existingRows[0];
      if ((existingLeg?.legType ?? 'drive') === 'rest') {
        const blocked = restLegBlockedFields(data as Record<string, unknown>);
        if (blocked.length > 0) {
          throw new Error(restLegEditRejectionMessage(blocked));
        }
      }

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
        // to existing DB values for unchanged coords (row fetched above for
        // the rest-leg guard).
        const cur = existingLeg;
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

      // Coords moved → the leg's cached fuel plan was computed for the old
      // route. Invalidate THIS leg's fuel cache so it re-sources lazily on the
      // next day-open (affected leg only — no trip-wide re-fan-out).
      if (coordsChanged) {
        await invalidateLegFuelCache(leg_id);
      }
      return;
    }

    case 'add_route': {
      const { data } = action.input;
      const leg_id = await resolveLegForStopOrRoute(
        action.input.leg_id,
        { lat: data.end_lat, lng: data.end_lng },
        tripId,
        userId,
        ctx
      );
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
      const leg_id = await resolveLegForStopOrRoute(
        proposedLegId,
        { lat: data.lat, lng: data.lng },
        tripId,
        userId,
        ctx
      );
      await addStop({
        leg_id,
        stop_type: data.stop_type,
        name: data.name,
        status: data.status ?? 'option',
        lat: data.lat ?? null,
        lng: data.lng ?? null,
        distance_from_start_km: data.distance_from_start_km ?? null,
        notes: data.notes ?? null,
        // Penny only authors 'other' stops — fuel rows (with fuel_type/amount)
        // come from Finn's server-side planner, never this path.
        fuel_type: null,
        fuel_amount_l: null,
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
// Post-dispatch leg contiguity check
//
// After Penny's tool calls land, verify that consecutive legs chain properly
// (leg N end ≈ leg N+1 start). A gap means Penny deleted a leg without
// updating the neighbor — the map will show a broken route.
//
// ANCHOR-AWARE: legs at/behind the driver's progress anchor are deliberately
// left alone by repairLegContinuity — their "gaps" record where the driver
// actually jumped (report_position re-points the upcoming leg, not history).
// Checking them re-logged the SAME behind-you gap on every subsequent turn
// (real case: a 217 km Bøverkinnhalsen→Heimdal gap spammed /admin/errors for
// days), burying real gaps in noise. Mirror the repair's anchor logic and
// start at the anchor pair.
// ---------------------------------------------------------------------------

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

  const anchorRows = await db
    .select({ currentLegId: trips.currentLegId })
    .from(trips)
    .where(eq(trips.id, tripId))
    .limit(1);
  const currentLegId = anchorRows[0]?.currentLegId ?? null;
  const anchorIndex = currentLegId
    ? Math.max(0, tripLegs.findIndex((l) => l.id === currentLegId))
    : 0;

  for (let i = anchorIndex; i < tripLegs.length - 1; i++) {
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
    case 'add_task':
      return {
        action: 'add_task',
        leg_id: action.input.leg_id ?? null,
        data: action.input.data,
      };
    case 'update_task':
      return { action: 'update_task', task_id: action.input.task_id, data: action.input.data };
    case 'rename_trip':
      return {
        action: 'rename_trip',
        ...(action.input.name !== undefined ? { name: action.input.name } : {}),
        ...(action.input.start_date ? { start_date: action.input.start_date } : {}),
        ...(action.input.end_date ? { end_date: action.input.end_date } : {}),
      };
    case 'report_position':
      return {
        action: 'report_position',
        lat: action.input.lat,
        lng: action.input.lng,
        ...(action.input.place_name ? { place_name: action.input.place_name } : {}),
        ...(action.input.next_leg_id ? { next_leg_id: action.input.next_leg_id } : {}),
      };
    case 'submit_idea':
      return { action: 'submit_idea', idea: action.input.idea };
  }
}
