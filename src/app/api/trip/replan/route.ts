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
  assertTaskOwnedByUser,
  errorResponse,
} from '@/server/auth/guards';
import { addChatMessage } from '@/server/repos/chat';
import { addRoute, updateRoute, deleteRoute } from '@/server/repos/routes';
import { addTask, updateTask, getLegTripId } from '@/server/repos/tasks';
import { addLeg, deleteLeg } from '@/server/repos/trips';
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
    if (result.changes?.changes) {
      for (const change of result.changes.changes) {
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
