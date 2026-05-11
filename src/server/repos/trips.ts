import 'server-only';
import { and, asc, eq, ne, or, sql } from 'drizzle-orm';
import { db } from '@/server/db/client';
import { ConflictError, HttpError } from '@/server/auth/guards';
import {
  trips,
  legs,
  costs,
  links,
  routes,
  routeLinks,
  stops,
  tasks,
  pois,
} from '@/server/db/schema';
import type {
  Leg,
  Trip,
  TripWithLegs,
  LegWithDetails,
  Cost,
  Link,
  RouteWithLinks,
  RouteLink,
  RouteLinkType,
  Stop,
  StopSource,
  StopStatus,
  StopType,
  FuelType,
  Task,
  TaskPriority,
  TaskStatus,
  TaskCreator,
  POI,
} from '@/types/trip';

function tripRow(r: typeof trips.$inferSelect): Trip {
  return {
    id: r.id,
    name: r.name,
    start_date: r.startDate,
    end_date: r.endDate,
    status: r.status,
    onboarding_state: r.onboardingState as Trip['onboarding_state'],
    created_at: r.createdAt.toISOString(),
    updated_at: r.updatedAt.toISOString(),
    user_id: r.userId,
    vehicle_id: r.vehicleId,
    is_template: r.isTemplate,
  };
}

function legRow(r: typeof legs.$inferSelect) {
  return {
    id: r.id,
    trip_id: r.tripId,
    sort_order: r.sortOrder,
    title: r.title,
    label: r.label,
    segment_index: r.segmentIndex,
    segment_name: r.segmentName,
    start_name: r.startName,
    end_name: r.endName,
    start_lat: r.startLat,
    start_lng: r.startLng,
    end_lat: r.endLat,
    end_lng: r.endLng,
    dates: r.dates,
    distance_km: r.distanceKm,
    drive_time_minutes: r.driveTimeMinutes,
    terrain: r.terrain,
    overnight: r.overnight,
    status: r.status,
    color: r.color,
    notes: r.notes,
    fuel_status: (r.fuelStatus as Leg['fuel_status']) ?? 'none',
    fuel_plan_error: r.fuelPlanError ?? null,
    created_at: r.createdAt.toISOString(),
    updated_at: r.updatedAt.toISOString(),
  };
}

function costRow(r: typeof costs.$inferSelect): Cost {
  return {
    id: r.id,
    leg_id: r.legId,
    item: r.item,
    estimate: r.estimate,
    is_total: r.isTotal,
  };
}

function linkRow(r: typeof links.$inferSelect): Link {
  return {
    id: r.id,
    leg_id: r.legId,
    label: r.label,
    url: r.url,
    type: r.type,
  };
}

function routeLinkRow(r: typeof routeLinks.$inferSelect): RouteLink {
  return {
    id: r.id,
    route_id: r.routeId,
    label: r.label,
    url: r.url,
    type: (r.type as RouteLinkType) ?? 'other',
  };
}

function routeRow(r: typeof routes.$inferSelect): RouteWithLinks {
  return {
    id: r.id,
    leg_id: r.legId,
    sort_order: r.sortOrder,
    label: r.label,
    description: r.description,
    distance_km: r.distanceKm,
    surface: r.surface,
    status: r.status,
    gpx_trail_id: r.gpxTrailId,
    end_lat: r.endLat,
    end_lng: r.endLng,
    end_name: r.endName,
    end_source: (r.endSource as RouteWithLinks['end_source']) ?? null,
    end_source_url: r.endSourceUrl,
    drive_time_minutes: r.driveTimeMinutes,
    links: [],
  };
}

function stopRow(r: typeof stops.$inferSelect): Stop {
  return {
    id: r.id,
    leg_id: r.legId,
    sort_order: r.sortOrder,
    stop_type: r.stopType as StopType,
    status: (r.status as StopStatus) ?? 'option',
    name: r.name,
    lat: r.lat,
    lng: r.lng,
    distance_from_start_km: r.distanceFromStartKm,
    notes: r.notes,
    fuel_type: (r.fuelType as FuelType | null) ?? null,
    fuel_amount_l: r.fuelAmountL,
    source: (r.source as StopSource | null) ?? null,
    source_url: r.sourceUrl,
    alternatives: r.alternatives ?? null,
    created_at: r.createdAt.toISOString(),
    updated_at: r.updatedAt.toISOString(),
  };
}

function taskRow(r: typeof tasks.$inferSelect): Task {
  return {
    id: r.id,
    trip_id: r.tripId,
    leg_id: r.legId,
    title: r.title,
    description: r.description,
    priority: (r.priority as TaskPriority) ?? 'normal',
    status: (r.status as TaskStatus) ?? 'open',
    reference_url: r.referenceUrl,
    reference_label: r.referenceLabel,
    reference_phone: r.referencePhone,
    answer: r.answer,
    answer_source_url: r.answerSourceUrl,
    answer_image_url: r.answerImageUrl,
    created_by: (r.createdBy as TaskCreator) ?? 'user',
    due_at: r.dueAt ? r.dueAt.toISOString() : null,
    created_at: r.createdAt.toISOString(),
    updated_at: r.updatedAt.toISOString(),
  };
}

function poiRow(r: typeof pois.$inferSelect): POI {
  return {
    id: r.id,
    leg_id: r.legId,
    source: r.source,
    external_id: r.externalId,
    name: r.name,
    lat: r.lat,
    lng: r.lng,
    type: r.type,
    description: r.description,
    rating: r.rating,
    url: r.url,
    data: r.data,
    last_verified: r.lastVerified ? r.lastVerified.toISOString() : null,
    status: r.status,
  };
}

export const rowMappers = {
  tripRow,
  legRow,
  costRow,
  linkRow,
  routeRow,
  routeLinkRow,
  stopRow,
  taskRow,
  poiRow,
};

// ---------------------------------------------------------------------------

export async function listTripsForUser(userId: string) {
  const rows = await db
    .select()
    .from(trips)
    .where(or(eq(trips.userId, userId), eq(trips.isTemplate, true)))
    .orderBy(asc(trips.isTemplate), asc(trips.id));
  return rows.map(tripRow);
}

export async function getTripFull(tripId: number): Promise<TripWithLegs | null> {
  const tripRows = await db.select().from(trips).where(eq(trips.id, tripId)).limit(1);
  if (tripRows.length === 0) return null;
  const trip = tripRow(tripRows[0]);

  const [legRows, costRows, linkRows, routeRows, routeLinkRows, stopRows, taskRows] =
    await Promise.all([
      db.select().from(legs).where(eq(legs.tripId, tripId)).orderBy(asc(legs.sortOrder)),
      db
        .select({ c: costs })
        .from(costs)
        .innerJoin(legs, eq(costs.legId, legs.id))
        .where(eq(legs.tripId, tripId)),
      db
        .select({ l: links })
        .from(links)
        .innerJoin(legs, eq(links.legId, legs.id))
        .where(eq(legs.tripId, tripId)),
      db
        .select({ r: routes })
        .from(routes)
        .innerJoin(legs, eq(routes.legId, legs.id))
        .where(eq(legs.tripId, tripId))
        .orderBy(asc(routes.sortOrder), asc(routes.id)),
      db
        .select({ rl: routeLinks })
        .from(routeLinks)
        .innerJoin(routes, eq(routeLinks.routeId, routes.id))
        .innerJoin(legs, eq(routes.legId, legs.id))
        .where(eq(legs.tripId, tripId))
        .orderBy(asc(routeLinks.id)),
      db
        .select({ s: stops })
        .from(stops)
        .innerJoin(legs, eq(stops.legId, legs.id))
        .where(eq(legs.tripId, tripId))
        .orderBy(asc(stops.sortOrder), asc(stops.id)),
      db.select().from(tasks).where(eq(tasks.tripId, tripId)).orderBy(asc(tasks.createdAt)),
    ]);

  const costsByLeg = new Map<number, Cost[]>();
  costRows.forEach(({ c }) => {
    const arr = costsByLeg.get(c.legId) || [];
    arr.push(costRow(c));
    costsByLeg.set(c.legId, arr);
  });

  const linksByLeg = new Map<number, Link[]>();
  linkRows.forEach(({ l }) => {
    const arr = linksByLeg.get(l.legId) || [];
    arr.push(linkRow(l));
    linksByLeg.set(l.legId, arr);
  });

  const routesById = new Map<number, RouteWithLinks>();
  const routesByLeg = new Map<number, RouteWithLinks[]>();
  routeRows.forEach(({ r }) => {
    const built = routeRow(r);
    routesById.set(r.id, built);
    const arr = routesByLeg.get(r.legId) || [];
    arr.push(built);
    routesByLeg.set(r.legId, arr);
  });
  routeLinkRows.forEach(({ rl }) => {
    const route = routesById.get(rl.routeId);
    if (route) route.links.push(routeLinkRow(rl));
  });

  const stopsByLeg = new Map<number, Stop[]>();
  stopRows.forEach(({ s }) => {
    const arr = stopsByLeg.get(s.legId) || [];
    arr.push(stopRow(s));
    stopsByLeg.set(s.legId, arr);
  });

  const tasksByLeg = new Map<number, Task[]>();
  const orphanTasks: Task[] = [];
  taskRows.forEach((t) => {
    const built = taskRow(t);
    if (built.leg_id == null) {
      orphanTasks.push(built);
      return;
    }
    const arr = tasksByLeg.get(built.leg_id) || [];
    arr.push(built);
    tasksByLeg.set(built.leg_id, arr);
  });

  const fullLegs: LegWithDetails[] = legRows.map((row) => {
    const leg = legRow(row);
    const parsedNotes = (() => {
      if (!leg.notes) return [];
      try {
        const v = JSON.parse(leg.notes);
        return Array.isArray(v) ? v : [];
      } catch {
        return [];
      }
    })();
    const legTasks = (tasksByLeg.get(leg.id) || []).slice().sort((a, b) => {
      const ao = a.status === 'open' ? 0 : 1;
      const bo = b.status === 'open' ? 0 : 1;
      if (ao !== bo) return ao - bo;
      return a.created_at.localeCompare(b.created_at);
    });
    return {
      ...leg,
      costs: costsByLeg.get(leg.id) || [],
      links: linksByLeg.get(leg.id) || [],
      routes: routesByLeg.get(leg.id) || [],
      stops: stopsByLeg.get(leg.id) || [],
      tasks: legTasks,
      parsedNotes,
    };
  });

  // Note: orphan (trip-level) tasks not currently surfaced in TripWithLegs;
  // see getTasksForTrip for that.
  void orphanTasks;

  return { ...trip, legs: fullLegs };
}

/**
 * Reject a trip name that already exists for this user (case-insensitive,
 * trimmed). Pass `excludeTripId` when validating a rename so the trip being
 * renamed doesn't conflict with itself.
 *
 * The DB also has a unique index on (user_id, lower(trim(name))) — see
 * migration 0005 — so this check is for the nice error message; the index
 * is the actual race-condition backstop.
 */
export async function assertTripNameAvailable(
  userId: string,
  name: string,
  excludeTripId?: number,
): Promise<void> {
  const normalized = name.trim().toLowerCase();
  if (!normalized) return; // Zod already rejects empty names; this is just defensive.
  const conditions = [
    eq(trips.userId, userId),
    sql`lower(trim(${trips.name})) = ${normalized}`,
  ];
  if (excludeTripId !== undefined) {
    conditions.push(ne(trips.id, excludeTripId));
  }
  const existing = await db
    .select({ id: trips.id })
    .from(trips)
    .where(and(...conditions))
    .limit(1);
  if (existing.length > 0) {
    throw new ConflictError(
      `A trip named "${name.trim()}" already exists. Pick a different name.`,
    );
  }
}

/**
 * Maximum allowable trip duration. 2 years is a sanity guard: it admits
 * "extended sabbaticals" and "round-the-world" itineraries, but rejects
 * obvious nonsense (a 10-year trip, a typo). Note this is NOT a cost cap —
 * a 2-year trip with auto-replan can still hit the Places API a lot.
 * Per-user spend caps live in usage.ts.
 */
export const MAX_TRIP_DURATION_DAYS = 730;

/**
 * Throw a 400-tier error if the (startDate, endDate) range exceeds the cap.
 *
 * Both dates must be present for the check to fire — open-ended trips
 * (start without end, or vice versa) are allowed since we can't compute
 * a duration. Invalid dates throw a parse error.
 */
export function assertTripDurationWithinLimit(
  startDate: string | null | undefined,
  endDate: string | null | undefined,
) {
  if (!startDate || !endDate) return;
  const startMs = Date.parse(startDate);
  const endMs = Date.parse(endDate);
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
    throw new HttpError(400, 'Trip start_date or end_date is not a valid date.');
  }
  if (endMs < startMs) {
    throw new HttpError(400, 'Trip end_date must be on or after start_date.');
  }
  const days = Math.ceil((endMs - startMs) / (24 * 60 * 60 * 1000));
  if (days > MAX_TRIP_DURATION_DAYS) {
    throw new HttpError(
      400,
      `Trip duration is ${days} days; the limit is ${MAX_TRIP_DURATION_DAYS} days (about 2 years). ` +
        `Split this into multiple trips, or shorten the date range.`,
    );
  }
}

export async function createTrip(input: {
  userId: string;
  name: string;
  startDate?: string | null;
  endDate?: string | null;
  vehicleId?: number | null;
}) {
  assertTripDurationWithinLimit(input.startDate, input.endDate);
  await assertTripNameAvailable(input.userId, input.name);
  const [row] = await db
    .insert(trips)
    .values({
      userId: input.userId,
      name: input.name,
      startDate: input.startDate ?? null,
      endDate: input.endDate ?? null,
      vehicleId: input.vehicleId ?? null,
    })
    .returning();
  return tripRow(row);
}

export async function deleteTrip(tripId: number) {
  await db.delete(trips).where(eq(trips.id, tripId));
}

/**
 * Append a new leg to the end of a trip. Used by Penny's `add_leg` action and
 * can be called directly from an API route when we need to build a trip from
 * scratch (e.g. "plan me a route from Girona to Berlin"). Returns the new
 * leg's id.
 */
export async function addLeg(input: {
  tripId: number;
  title: string;
  label?: string | null;
  startName?: string | null;
  endName?: string | null;
  startLat?: number | null;
  startLng?: number | null;
  endLat?: number | null;
  endLng?: number | null;
  dates?: string | null;
  distanceKm?: number | null;
  driveTimeMinutes?: number | null;
  terrain?: string | null;
  overnight?: string | null;
  status?: string | null;
  color?: string | null;
  notes?: string | null;
  sortOrder?: number | null;
  /**
   * Two-level grouping. Set both fields together when this driving day belongs
   * to a user-stated jump that takes more than one day; leave both null for
   * single-day jumps or for legs you don't want grouped. See migration 0006.
   */
  segmentIndex?: number | null;
  segmentName?: string | null;
}): Promise<number> {
  let sortOrder = input.sortOrder;
  if (sortOrder == null) {
    const existing = await db
      .select({ sortOrder: legs.sortOrder })
      .from(legs)
      .where(eq(legs.tripId, input.tripId));
    sortOrder = (existing.reduce((m, r) => Math.max(m, r.sortOrder), -1) ?? -1) + 1;
  }

  const [row] = await db
    .insert(legs)
    .values({
      tripId: input.tripId,
      sortOrder,
      title: input.title,
      label: input.label ?? null,
      startName: input.startName ?? null,
      endName: input.endName ?? null,
      startLat: input.startLat ?? null,
      startLng: input.startLng ?? null,
      endLat: input.endLat ?? null,
      endLng: input.endLng ?? null,
      dates: input.dates ?? null,
      distanceKm: input.distanceKm ?? null,
      driveTimeMinutes: input.driveTimeMinutes ?? null,
      terrain: input.terrain ?? null,
      overnight: input.overnight ?? null,
      status: input.status ?? 'planning',
      color: input.color ?? null,
      notes: input.notes ?? null,
      segmentIndex: input.segmentIndex ?? null,
      segmentName: input.segmentName ?? null,
    })
    .returning({ id: legs.id });
  return row.id;
}

export async function deleteLeg(legId: number): Promise<void> {
  await db.delete(legs).where(eq(legs.id, legId));
}

/**
 * Deep-copy a template trip into a new trip owned by `userId`. Returns the new trip id.
 * Copies legs, costs, links, routes, route_links, tasks, gpx trails, pois.
 * Chat history is NOT copied.
 */
export async function cloneTrip(sourceTripId: number, userId: string): Promise<number> {
  const src = await db.select().from(trips).where(eq(trips.id, sourceTripId)).limit(1);
  if (src.length === 0) throw new Error('Source trip not found');
  const s = src[0];

  return await db.transaction(async (tx) => {
    // Find an available "(copy)" / "(copy 2)" / "(copy N)" suffix. The unique
    // index on (user_id, lower(trim(name))) means a naive "(copy)" suffix
    // would crash the second time the same template is cloned. Probing inside
    // the transaction reduces (but doesn't eliminate) the race; the DB unique
    // index is the actual backstop.
    let newName = `${s.name} (copy)`;
    for (let i = 1; i < 100; i++) {
      const candidate = i === 1 ? `${s.name} (copy)` : `${s.name} (copy ${i})`;
      const taken = await tx
        .select({ id: trips.id })
        .from(trips)
        .where(
          and(
            eq(trips.userId, userId),
            sql`lower(trim(${trips.name})) = ${candidate.trim().toLowerCase()}`,
          ),
        )
        .limit(1);
      if (taken.length === 0) {
        newName = candidate;
        break;
      }
      // Pathological case: 100 copies. Fall back to a timestamp suffix.
      if (i === 99) newName = `${s.name} (copy ${Date.now()})`;
    }

    const [newTrip] = await tx
      .insert(trips)
      .values({
        userId,
        vehicleId: null,
        name: newName,
        startDate: s.startDate,
        endDate: s.endDate,
        status: 'planning',
        isTemplate: false,
      })
      .returning();
    const newTripId = newTrip.id;

    const srcLegs = await tx.select().from(legs).where(eq(legs.tripId, sourceTripId));
    const legIdMap = new Map<number, number>();
    for (const l of srcLegs) {
      const [nl] = await tx
        .insert(legs)
        .values({
          tripId: newTripId,
          sortOrder: l.sortOrder,
          title: l.title,
          label: l.label,
          startName: l.startName,
          endName: l.endName,
          startLat: l.startLat,
          startLng: l.startLng,
          endLat: l.endLat,
          endLng: l.endLng,
          dates: l.dates,
          distanceKm: l.distanceKm,
          driveTimeMinutes: l.driveTimeMinutes,
          terrain: l.terrain,
          overnight: l.overnight,
          status: l.status,
          color: l.color,
          notes: l.notes,
          // Carry segment grouping into the cloned trip so the new copy renders
          // the same shape (flat vs. grouped) as the source template.
          segmentIndex: l.segmentIndex,
          segmentName: l.segmentName,
        })
        .returning({ id: legs.id });
      legIdMap.set(l.id, nl.id);
    }

    if (legIdMap.size > 0) {
      const srcCosts = await tx
        .select()
        .from(costs)
        .innerJoin(legs, eq(costs.legId, legs.id))
        .where(eq(legs.tripId, sourceTripId));
      for (const { costs: c } of srcCosts) {
        const newLegId = legIdMap.get(c.legId);
        if (!newLegId) continue;
        await tx.insert(costs).values({
          legId: newLegId,
          item: c.item,
          estimate: c.estimate,
          isTotal: c.isTotal,
        });
      }

      const srcLinks = await tx
        .select()
        .from(links)
        .innerJoin(legs, eq(links.legId, legs.id))
        .where(eq(legs.tripId, sourceTripId));
      for (const { links: lk } of srcLinks) {
        const newLegId = legIdMap.get(lk.legId);
        if (!newLegId) continue;
        await tx.insert(links).values({
          legId: newLegId,
          label: lk.label,
          url: lk.url,
          type: lk.type,
        });
      }

      const srcRoutes = await tx
        .select()
        .from(routes)
        .innerJoin(legs, eq(routes.legId, legs.id))
        .where(eq(legs.tripId, sourceTripId));
      const routeIdMap = new Map<number, number>();
      for (const { routes: r } of srcRoutes) {
        const newLegId = legIdMap.get(r.legId);
        if (!newLegId) continue;
        const [nr] = await tx
          .insert(routes)
          .values({
            legId: newLegId,
            sortOrder: r.sortOrder,
            label: r.label,
            description: r.description,
            distanceKm: r.distanceKm,
            surface: r.surface,
            status: r.status,
            gpxTrailId: null, // gpx not copied yet
            endLat: r.endLat,
            endLng: r.endLng,
            endName: r.endName,
            endSource: r.endSource,
            endSourceUrl: r.endSourceUrl,
            driveTimeMinutes: r.driveTimeMinutes,
          })
          .returning({ id: routes.id });
        routeIdMap.set(r.id, nr.id);
      }

      const srcRouteLinks = await tx
        .select()
        .from(routeLinks)
        .innerJoin(routes, eq(routeLinks.routeId, routes.id))
        .innerJoin(legs, eq(routes.legId, legs.id))
        .where(eq(legs.tripId, sourceTripId));
      for (const { route_links: rl } of srcRouteLinks) {
        const newRouteId = routeIdMap.get(rl.routeId);
        if (!newRouteId) continue;
        await tx.insert(routeLinks).values({
          routeId: newRouteId,
          label: rl.label,
          url: rl.url,
          type: rl.type,
        });
      }

      const srcStops = await tx
        .select()
        .from(stops)
        .innerJoin(legs, eq(stops.legId, legs.id))
        .where(eq(legs.tripId, sourceTripId));
      for (const { stops: s } of srcStops) {
        const newLegId = legIdMap.get(s.legId);
        if (!newLegId) continue;
        await tx.insert(stops).values({
          legId: newLegId,
          sortOrder: s.sortOrder,
          stopType: s.stopType,
          status: s.status,
          name: s.name,
          lat: s.lat,
          lng: s.lng,
          distanceFromStartKm: s.distanceFromStartKm,
          notes: s.notes,
          fuelType: s.fuelType,
          fuelAmountL: s.fuelAmountL,
          source: s.source,
          sourceUrl: s.sourceUrl,
        });
      }

      const srcTasks = await tx.select().from(tasks).where(eq(tasks.tripId, sourceTripId));
      for (const t of srcTasks) {
        const newLegId = t.legId ? legIdMap.get(t.legId) ?? null : null;
        await tx.insert(tasks).values({
          tripId: newTripId,
          legId: newLegId,
          title: t.title,
          description: t.description,
          priority: t.priority,
          status: 'open',
          referenceUrl: t.referenceUrl,
          referenceLabel: t.referenceLabel,
          referencePhone: t.referencePhone,
          answer: null,
          answerSourceUrl: null,
          answerImageUrl: null,
          createdBy: t.createdBy,
          dueAt: t.dueAt,
        });
      }

      const srcPois = await tx.select().from(pois).where(eq(pois.tripId, sourceTripId));
      for (const p of srcPois) {
        const newLegId = p.legId ? legIdMap.get(p.legId) ?? null : null;
        await tx.insert(pois).values({
          tripId: newTripId,
          legId: newLegId,
          source: p.source,
          externalId: p.externalId,
          name: p.name,
          lat: p.lat,
          lng: p.lng,
          type: p.type,
          description: p.description,
          rating: p.rating,
          url: p.url,
          data: p.data,
          status: p.status,
        });
      }
    }

    return newTripId;
  });
}
