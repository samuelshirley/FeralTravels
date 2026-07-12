import 'server-only';
import { and, asc, desc, eq, gt, inArray, like, lt, lte, ne, or, isNotNull, sql } from 'drizzle-orm';
import { db } from '@/server/db/client';
import { ConflictError, HttpError } from '@/server/auth/guards';
import {
  tryParseToISO,
  legDateISO,
  constraintLocalDateISO,
  todayISO,
  todayISOInZone,
} from '@/lib/dates';
import { seasonalTripName, isPlaceholderTripName } from '@/lib/tripNaming';
import {
  materializeSchedule,
  computeStartFixes,
  resolveContinuityRoute,
  type ScheduleStop,
  type ContinuityLeg,
  type ContinuityRouteOutcome,
} from '@/lib/penny/schedule';
import { getDirections } from '@/lib/google/directions';
import { inferInsertAfterSort } from '@/lib/penny/legPlacement';
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
  legConstraints,
  users,
  chatHistory,
  type GeoJSONLineString,
} from '@/server/db/schema';
import type {
  Leg,
  Trip,
  TripWithLegs,
  TripStatus,
  LegWithDetails,
  LegConstraint,
  ConstraintType,
  Cost,
  Link,
  RouteWithLinks,
  RouteLink,
  RouteLinkType,
  Stop,
  StopSource,
  StopStatus,
  StopType,
  StopPriceState,
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
    start_date_parsed: r.startDateParsed, // non-null invariant
    end_date_parsed: r.endDateParsed ?? null,
    status: r.status,
    trip_status: (r.tripStatus as TripStatus) ?? 'draft',
    onboarding_state: r.onboardingState as Trip['onboarding_state'],
    prefer_avoid_highways: !!r.preferAvoidHighways,
    last_known_lat: r.lastKnownLat ?? null,
    last_known_lng: r.lastKnownLng ?? null,
    last_known_place: r.lastKnownPlace ?? null,
    position_updated_at: r.positionUpdatedAt ? r.positionUpdatedAt.toISOString() : null,
    current_leg_id: r.currentLegId ?? null,
    current_lat: r.currentLat ?? null,
    current_lng: r.currentLng ?? null,
    progress_anchor_date: r.progressAnchorDate ?? null,
    progress_updated_at: r.progressUpdatedAt ? r.progressUpdatedAt.toISOString() : null,
    declared_range_km: r.declaredRangeKm ?? null,
    declared_range_leg_id: r.declaredRangeLegId ?? null,
    declared_range_at: r.declaredRangeAt ? r.declaredRangeAt.toISOString() : null,
    created_at: r.createdAt.toISOString(),
    updated_at: r.updatedAt.toISOString(),
    user_id: r.userId,
    vehicle_id: r.vehicleId,
    is_template: r.isTemplate,
  };
}

function legConstraintRow(r: typeof legConstraints.$inferSelect): LegConstraint {
  return {
    id: r.id,
    leg_id: r.legId,
    constraint_type: r.constraintType as ConstraintType,
    constraint_datetime: r.constraintDatetime ? r.constraintDatetime.toISOString() : null,
    buffer_minutes: r.bufferMinutes,
    note: r.note,
    created_at: r.createdAt.toISOString(),
  };
}

function legRow(r: typeof legs.$inferSelect) {
  return {
    id: r.id,
    trip_id: r.tripId,
    sort_order: r.sortOrder,
    leg_type: (r.legType as Leg['leg_type']) ?? 'drive',
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
    fuel_stops_updated_at: r.fuelStopsUpdatedAt ? r.fuelStopsUpdatedAt.toISOString() : null,
    continuity_warning: r.continuityWarning ?? null,
    geometry: r.geometry ?? null,
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
    place_id: r.placeId ?? null,
    google_maps_uri: r.googleMapsUri ?? null,
    price_state: (r.priceState as StopPriceState | null) ?? null,
    price_per_litre: r.pricePerLitre ?? null,
    price_currency: r.priceCurrency ?? null,
    price_fuel_type: r.priceFuelType ?? null,
    price_country: r.priceCountry ?? null,
    price_source: r.priceSource ?? null,
    price_as_of: r.priceAsOf ? r.priceAsOf.toISOString() : null,
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
  legConstraintRow,
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
  // "Last activity" for list ordering — most recently used/changed first.
  // trips.updated_at alone is NOT enough: most edits land on legs (Penny
  // replans, day-open fuel sourcing) or only in chat_history (a conversation
  // with no plan change), neither of which bumps the trips row. GREATEST of
  // all three is what "most recently used" actually means.
  const lastActivity = sql`GREATEST(
    ${trips.updatedAt},
    COALESCE((SELECT max(${legs.updatedAt}) FROM ${legs} WHERE ${legs.tripId} = ${trips.id}), ${trips.updatedAt}),
    COALESCE((SELECT max(${chatHistory.createdAt}) FROM ${chatHistory} WHERE ${chatHistory.tripId} = ${trips.id}), ${trips.updatedAt})
  )`;
  const rows = await db
    .select()
    .from(trips)
    .where(or(eq(trips.userId, userId), eq(trips.isTemplate, true)))
    .orderBy(asc(trips.isTemplate), desc(lastActivity), asc(trips.id));
  return rows.map(tripRow);
}

export async function getTripFull(tripId: string): Promise<TripWithLegs | null> {
  const tripRows = await db.select().from(trips).where(eq(trips.id, tripId)).limit(1);
  if (tripRows.length === 0) return null;
  const trip = tripRow(tripRows[0]);

  // The owner's timezone defines "today" for date anchoring below. Resolved here
  // (not via todayISO()) so the server agrees with the driver's wall clock — the
  // server runs in UTC, so a bare todayISO() drifts a day near midnight.
  const ownerTz = tripRows[0].userId
    ? (
        await db
          .select({ timezone: users.timezone })
          .from(users)
          .where(eq(users.id, tripRows[0].userId))
          .limit(1)
      )[0]?.timezone ?? null
    : null;

  const [legRows, costRows, linkRows, routeRows, routeLinkRows, stopRows, taskRows, constraintRows] =
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
      db
        .select({ lc: legConstraints })
        .from(legConstraints)
        .innerJoin(legs, eq(legConstraints.legId, legs.id))
        .where(eq(legs.tripId, tripId))
        .orderBy(asc(legConstraints.createdAt)),
    ]);

  const costsByLeg = new Map<string, Cost[]>();
  costRows.forEach(({ c }) => {
    const arr = costsByLeg.get(c.legId) || [];
    arr.push(costRow(c));
    costsByLeg.set(c.legId, arr);
  });

  const linksByLeg = new Map<string, Link[]>();
  linkRows.forEach(({ l }) => {
    const arr = linksByLeg.get(l.legId) || [];
    arr.push(linkRow(l));
    linksByLeg.set(l.legId, arr);
  });

  const routesById = new Map<string, RouteWithLinks>();
  const routesByLeg = new Map<string, RouteWithLinks[]>();
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

  const stopsByLeg = new Map<string, Stop[]>();
  stopRows.forEach(({ s }) => {
    const arr = stopsByLeg.get(s.legId) || [];
    arr.push(stopRow(s));
    stopsByLeg.set(s.legId, arr);
  });

  const constraintsByLeg = new Map<string, LegConstraint[]>();
  constraintRows.forEach(({ lc }) => {
    const arr = constraintsByLeg.get(lc.legId) || [];
    arr.push(legConstraintRow(lc));
    constraintsByLeg.set(lc.legId, arr);
  });

  const tasksByLeg = new Map<string, Task[]>();
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

  // Re-anchor the calendar from the driver's reported progress. When a current
  // leg is set, that leg falls on `progress_anchor_date` (or today if unset), so
  // the *effective* trip start is that date shifted back by the current leg's
  // rank. This pushes already-passed days into the past and re-dates the
  // remaining legs from "now", which is what makes the itinerary reflect reality
  // after the driver reports falling short of a leg. With no progress set we use
  // the trip's real start date exactly as before.
  let effectiveStartISO = trip.start_date_parsed;
  if (trip.current_leg_id) {
    const currentRank = legRows.findIndex((l) => l.id === trip.current_leg_id);
    if (currentRank >= 0) {
      const anchor = trip.progress_anchor_date ?? todayISOInZone(ownerTz);
      effectiveStartISO = legDateISO(anchor, -currentRank);
    }
  }

  const fullLegs: LegWithDetails[] = legRows.map((row, index) => {
    const leg = legRow(row);
    // Server-side calendar-date assignment: every leg (driving or rest) is one
    // calendar day, so the date is the effective trip start plus the leg's rank
    // in the sort_order-ordered list. Computed here (not on the client) so the
    // date is a single source of truth the feasibility/enforcement layers read.
    const date_iso = legDateISO(effectiveStartISO, index);
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
      date_iso,
      costs: costsByLeg.get(leg.id) || [],
      links: linksByLeg.get(leg.id) || [],
      routes: routesByLeg.get(leg.id) || [],
      stops: stopsByLeg.get(leg.id) || [],
      tasks: legTasks,
      constraints: constraintsByLeg.get(leg.id) || [],
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
 * The DB also has a unique index on (user_id, trip_name_ci_key) — see
 * migrations 0005 + 0015 — so this check is for the nice error message; the index
 * is the actual race-condition backstop.
 */
export async function assertTripNameAvailable(
  userId: string,
  name: string,
  excludeTripId?: string,
): Promise<void> {
  const normalized = name.trim().toLowerCase();
  if (!normalized) return; // Zod already rejects empty names; this is just defensive.
  const conditions = [eq(trips.userId, userId), eq(trips.tripNameCiKey, normalized)];
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

/**
 * Probe for the first free "<base>" / "<base> 2" / "<base> 3" … slot for this
 * user. Trip names are unique per user (unique index on user_id +
 * trip_name_ci_key), so auto-assigned names (the "New trip" placeholder and the
 * seasonal names) need a numeric suffix when they'd collide.
 *
 * Not race-proof on its own: two simultaneous creates can pick the same slot.
 * The unique index is the ultimate backstop; callers that need it retry.
 */
export async function findAvailableTripName(userId: string, base: string): Promise<string> {
  const baseKey = base.trim().toLowerCase();
  const rows = await db
    .select({ key: trips.tripNameCiKey })
    .from(trips)
    .where(and(eq(trips.userId, userId), like(trips.tripNameCiKey, `${baseKey}%`)));
  const taken = new Set(rows.map((r) => r.key));
  if (!taken.has(baseKey)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base} ${i}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  // Pathological fallback — timestamp keeps it unique.
  return `${base} ${Date.now()}`;
}

/**
 * Unique "New trip" placeholder for a trip created without a name. The "+ New
 * trip" button no longer asks for one — the app auto-names the trip from its
 * season/dates once a start date is known (see {@link autoNameTripFromSeason}) —
 * so this is only what shows in the navbar until then.
 */
export async function generateDefaultTripName(userId: string): Promise<string> {
  return findAvailableTripName(userId, 'New trip');
}

/**
 * Auto-name a trip from its season/dates once a start date is known — but only
 * while it still carries an auto-assigned placeholder ("New trip"). A real name
 * (set by the user, or by Penny on explicit request) is never overwritten.
 * No-op when there's no start date yet. Deterministic, no LLM — see
 * {@link seasonalTripName}. Callers run this after the trip's dates are saved.
 */
export async function autoNameTripFromSeason(tripId: string, userId: string): Promise<void> {
  const [row] = await db
    .select({
      name: trips.name,
      startISO: trips.startDateParsed,
      endISO: trips.endDateParsed,
    })
    .from(trips)
    .where(eq(trips.id, tripId))
    .limit(1);
  if (!row) return; // trip not found
  if (!isPlaceholderTripName(row.name)) return; // real name → leave it alone

  const base = seasonalTripName(row.startISO, row.endISO);
  if (!base) return; // unparseable date → keep the placeholder

  const name = await findAvailableTripName(userId, base);
  await db
    .update(trips)
    .set({ name, updatedAt: new Date() })
    .where(eq(trips.id, tripId));
}

export async function createTrip(input: {
  userId: string;
  name: string;
  startDate?: string | null;
  endDate?: string | null;
  vehicleId?: string | null;
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
      // start_date_parsed is a hard non-null invariant. We seed today as a
      // placeholder when the caller gives no parseable date; the forced
      // onboarding `trip_date` question overwrites it with the user's real date
      // before planning begins.
      startDateParsed: tryParseToISO(input.startDate) ?? todayISO(),
      endDateParsed: tryParseToISO(input.endDate),
      vehicleId: input.vehicleId ?? null,
    })
    .returning();
  return tripRow(row);
}

export async function deleteTrip(tripId: string) {
  await db.delete(trips).where(eq(trips.id, tripId));
}

/**
 * Append a new leg to the end of a trip. Used by Penny's `add_leg` action and
 * can be called directly from an API route when we need to build a trip from
 * scratch (e.g. "plan me a route from Girona to Berlin"). Returns the new
 * leg's id.
 */
export async function addLeg(input: {
  tripId: string;
  title: string;
  /** 'drive' (default) or 'rest' for non-driving stop days. */
  legType?: string | null;
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
   * single-day jumps or for legs you don't want grouped.
   */
  segmentIndex?: number | null;
  segmentName?: string | null;
  /**
   * Insert this leg immediately AFTER an existing leg (by id), shifting the
   * rest of the trip down to make room. This is how a new mid-route destination
   * lands in the right place instead of being appended to the end (which made
   * the route hop back and forth once continuity repair chained it in order).
   * Takes precedence over `sortOrder`. Ignored if the id isn't on this trip.
   */
  afterLegId?: string | null;
  /** GeoJSON LineString for the driving route — persisted at planning time. */
  geometry?: GeoJSONLineString | null;
}): Promise<string> {
  let sortOrder = input.sortOrder;
  // Positional insert: place the new leg right after `afterLegId` and bump every
  // later leg up by one so sort_order stays the route order. Done before the
  // max+1 fallback so an explicit placement always wins.
  if (input.afterLegId) {
    const afterRows = await db
      .select({ sortOrder: legs.sortOrder })
      .from(legs)
      .where(and(eq(legs.id, input.afterLegId), eq(legs.tripId, input.tripId)))
      .limit(1);
    if (afterRows[0]) {
      const base = afterRows[0].sortOrder;
      await db
        .update(legs)
        .set({ sortOrder: sql`${legs.sortOrder} + 1`, updatedAt: new Date() })
        .where(and(eq(legs.tripId, input.tripId), gt(legs.sortOrder, base)));
      sortOrder = base + 1;
    }
  }
  if (sortOrder == null) {
    const existing = await db
      .select({ sortOrder: legs.sortOrder, endLat: legs.endLat, endLng: legs.endLng })
      .from(legs)
      .where(eq(legs.tripId, input.tripId));
    // No explicit placement: infer it from geography before falling back to
    // append. A leg whose START matches an existing leg's END belongs right
    // after that leg — not at the end of the trip (where continuity repair
    // would chain it to whatever the last leg is and manufacture a monster
    // day; see lib/penny/legPlacement.ts for the 3,383 km incident).
    const inferredAfterSort = inferInsertAfterSort(
      existing,
      input.startLat ?? null,
      input.startLng ?? null,
    );
    if (inferredAfterSort != null) {
      await db
        .update(legs)
        .set({ sortOrder: sql`${legs.sortOrder} + 1`, updatedAt: new Date() })
        .where(and(eq(legs.tripId, input.tripId), gt(legs.sortOrder, inferredAfterSort)));
      sortOrder = inferredAfterSort + 1;
    } else {
      sortOrder = existing.reduce((m, r) => Math.max(m, r.sortOrder), -1) + 1;
    }
  }

  const [row] = await db
    .insert(legs)
    .values({
      tripId: input.tripId,
      sortOrder,
      legType: input.legType ?? 'drive',
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
      geometry: input.geometry ?? null,
    })
    .returning({ id: legs.id });
  return row.id;
}

export async function deleteLeg(legId: string): Promise<void> {
  await db.delete(legs).where(eq(legs.id, legId));
}

/** Title for a server-generated rest-day leg at a named location. */
function restDayTitle(name: string | null): string {
  return name ? `${name} (rest day)` : 'Rest day';
}

/** Great-circle distance in km. Local copy to keep this module self-contained. */
function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
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

/**
 * Assign an existing rest leg to the drive whose destination it sits at. Rest
 * legs carry their location in their own start/end coords; the matching drive is
 * the one whose END coords are closest (that's the drive that arrives at this
 * stay). Falls back to the last drive when coords are missing.
 */
function nearestDriveStopIndex(
  rest: { startLat: number | null; startLng: number | null; endLat: number | null; endLng: number | null },
  driveLegs: Array<{ endLat: number | null; endLng: number | null }>,
): number {
  const rlat = rest.startLat ?? rest.endLat;
  const rlng = rest.startLng ?? rest.endLng;
  if (rlat == null || rlng == null) return driveLegs.length - 1;
  let best = driveLegs.length - 1;
  let bestKm = Infinity;
  for (let i = 0; i < driveLegs.length; i++) {
    const d = driveLegs[i];
    if (d.endLat == null || d.endLng == null) continue;
    const km = haversineKm(rlat, rlng, d.endLat, d.endLng);
    if (km < bestKm) {
      bestKm = km;
      best = i;
    }
  }
  return best;
}

export interface ScheduleInfeasibilityOut {
  legId: string;
  anchorDateISO: string;
  reason: string;
}

/**
 * Deterministically rebuild a trip's rest-day legs and leg ordering from its
 * DRIVING legs + fixed-date constraints. This is the server taking ownership of
 * the schedule (see src/lib/penny/schedule.ts for the math and the motivating
 * bug): Penny can no longer miscount rest days or leave a rest day stranded
 * after the drive it was meant to precede.
 *
 * What it does, given the trip start date:
 *   - Treats each drive leg (in its current order) as a "stop".
 *   - Derives desired nights at each stop from the rest legs currently there.
 *   - Reads dated arrive_by/depart_after constraints as fixed-date anchors.
 *   - Computes the correct rest-day allocation + chronological ordering.
 *   - Reconciles to the DB: reuses existing rest rows (preserving their data),
 *     creates any extra rest rows needed, deletes surplus ones, and renumbers
 *     every leg's sort_order so the list is in calendar order.
 *
 * Idempotent: a no-op when the trip is already correct (no writes). Safe to call
 * after every plan edit. Returns any fixed dates that are physically impossible
 * (the driving alone overruns them) for the caller to surface.
 *
 * NOTE: it trusts the current ORDER of drive legs (route order); it fixes rest
 * placement/count and overall sort_order, not a scrambled drive sequence.
 */
export async function rebuildTripSchedule(
  tripId: string,
): Promise<ScheduleInfeasibilityOut[]> {
  const tripRows = await db
    .select({ startDateParsed: trips.startDateParsed })
    .from(trips)
    .where(eq(trips.id, tripId))
    .limit(1);
  const tripRow = tripRows[0];
  if (!tripRow) return []; // trip not found
  // start_date_parsed is a hard non-null invariant — always a real calendar day.
  const startISO = tripRow.startDateParsed;

  const legRows = await db
    .select()
    .from(legs)
    .where(eq(legs.tripId, tripId))
    .orderBy(asc(legs.sortOrder));
  const driveLegs = legRows.filter((l) => (l.legType ?? 'drive') !== 'rest');
  const restLegs = legRows.filter((l) => (l.legType ?? 'drive') === 'rest');
  if (driveLegs.length === 0) return []; // nothing to anchor a schedule on

  // Dated constraints → an anchor date per drive leg.
  const constraintRows = await db
    .select({ lc: legConstraints })
    .from(legConstraints)
    .innerJoin(legs, eq(legConstraints.legId, legs.id))
    .where(eq(legs.tripId, tripId));
  const anchorByLegId = new Map<string, string>();
  for (const { lc } of constraintRows) {
    if (
      (lc.constraintType === 'arrive_by' || lc.constraintType === 'depart_after') &&
      lc.constraintDatetime
    ) {
      const iso = constraintLocalDateISO(lc.constraintDatetime.toISOString());
      if (iso) anchorByLegId.set(lc.legId, iso);
    }
  }

  // Assign each existing rest leg to its stop (the drive that arrives there).
  const restsByStop = new Map<number, string[]>();
  for (const rest of restLegs) {
    const idx = nearestDriveStopIndex(rest, driveLegs);
    const arr = restsByStop.get(idx) ?? [];
    arr.push(rest.id);
    restsByStop.set(idx, arr);
  }

  const stops: ScheduleStop[] = driveLegs.map((d, i) => ({
    driveId: d.id,
    endName: d.endName,
    endLat: d.endLat,
    endLng: d.endLng,
    desiredNights: (restsByStop.get(i) ?? []).length,
    anchorDateISO: anchorByLegId.get(d.id) ?? null,
  }));

  const result = materializeSchedule({ tripStartISO: startISO, stops });

  // Reconcile the generated leg list to DB rows.
  const restPool = new Map<number, string[]>();
  for (const [k, v] of restsByStop) restPool.set(k, [...v]);

  type LegUpdate = {
    id: string;
    sortOrder: number;
    stop?: ScheduleStop;
    segmentIndex?: number | null;
    segmentName?: string | null;
  };
  const updates: LegUpdate[] = [];
  const inserts: Array<typeof legs.$inferInsert> = [];
  const usedRestIds = new Set<string>();

  for (const gl of result.legs) {
    if (gl.kind === 'drive') {
      updates.push({ id: gl.driveId as string, sortOrder: gl.rank });
      continue;
    }
    const stop = stops[gl.stopIndex];
    const anchorDrive = driveLegs[gl.stopIndex];
    const segmentIndex = anchorDrive?.segmentIndex ?? null;
    const segmentName = anchorDrive?.segmentName ?? null;
    const pool = restPool.get(gl.stopIndex);
    const reuseId = pool && pool.length > 0 ? pool.shift() ?? null : null;
    if (reuseId) {
      usedRestIds.add(reuseId);
      updates.push({
        id: reuseId,
        sortOrder: gl.rank,
        stop,
        segmentIndex,
        segmentName,
      });
    } else {
      inserts.push({
        tripId,
        sortOrder: gl.rank,
        legType: 'rest',
        title: restDayTitle(stop.endName),
        startName: stop.endName,
        endName: stop.endName,
        startLat: stop.endLat,
        startLng: stop.endLng,
        endLat: stop.endLat,
        endLng: stop.endLng,
        segmentIndex,
        segmentName,
        status: 'planning',
      });
    }
  }
  const toDelete = restLegs.filter((r) => !usedRestIds.has(r.id)).map((r) => r.id);

  const infeasibleOut: ScheduleInfeasibilityOut[] = result.infeasible.map((inf) => ({
    legId: driveLegs[inf.stopIndex].id,
    anchorDateISO: inf.anchorDateISO,
    reason: inf.reason,
  }));

  // Idempotency: skip all writes when nothing actually changes. Avoids churn on
  // the (common) edits that don't touch dates or ordering.
  const byId = new Map(legRows.map((l) => [l.id, l]));
  const nothingChanged =
    inserts.length === 0 &&
    toDelete.length === 0 &&
    updates.every((u) => {
      const cur = byId.get(u.id);
      if (!cur) return false;
      if (cur.sortOrder !== u.sortOrder) return false;
      if (!u.stop) return true;
      return (
        cur.startLat === u.stop.endLat &&
        cur.startLng === u.stop.endLng &&
        cur.endLat === u.stop.endLat &&
        cur.endLng === u.stop.endLng &&
        cur.endName === u.stop.endName &&
        cur.segmentIndex === (u.segmentIndex ?? null) &&
        cur.segmentName === (u.segmentName ?? null)
      );
    });
  if (nothingChanged) return infeasibleOut;

  await db.transaction(async (tx) => {
    for (const u of updates) {
      const set: Record<string, unknown> = { sortOrder: u.sortOrder, updatedAt: new Date() };
      if (u.stop) {
        // Keep the reused rest row pinned to its stay location + stop-to-stop segment.
        set.legType = 'rest';
        set.title = restDayTitle(u.stop.endName);
        set.startName = u.stop.endName;
        set.endName = u.stop.endName;
        set.startLat = u.stop.endLat;
        set.startLng = u.stop.endLng;
        set.endLat = u.stop.endLat;
        set.endLng = u.stop.endLng;
        set.segmentIndex = u.segmentIndex ?? null;
        set.segmentName = u.segmentName ?? null;
      }
      await tx.update(legs).set(set).where(eq(legs.id, u.id));
    }
    if (inserts.length > 0) await tx.insert(legs).values(inserts);
    if (toDelete.length > 0) await tx.delete(legs).where(inArray(legs.id, toDelete));
  });

  return infeasibleOut;
}

/**
 * A leg's selected pass-through stops as routing waypoints, in along-route order.
 *
 * These are the stops the user/Penny marked status='selected' (e.g. "drive over
 * the Millau bridge" → an `other` stop, selected). They are the SAME set that
 * goes into the leg's "Open in Google Maps" handoff URL — feeding them into
 * Directions here is what makes the in-app polyline / distance / drive time agree
 * with that handoff instead of routing straight and ignoring the detour.
 *
 * Ordered by distance_from_start_km (the field exists precisely so a waypoint
 * sorts along the leg), falling back to sort_order. Stops without coordinates are
 * dropped — they can't be routed through.
 */
async function selectedWaypointsForLeg(
  legId: string,
): Promise<Array<{ lat: number; lng: number }>> {
  const rows = await db
    .select({
      lat: stops.lat,
      lng: stops.lng,
    })
    .from(stops)
    .where(and(eq(stops.legId, legId), eq(stops.status, 'selected')))
    .orderBy(asc(stops.distanceFromStartKm), asc(stops.sortOrder));
  return rows
    .filter((r) => r.lat != null && r.lng != null)
    .map((r) => ({ lat: r.lat as number, lng: r.lng as number }));
}

/**
 * Re-route a single drive leg through its selected pass-through stops and persist
 * the resulting distance / drive time / geometry. Call this after any change to a
 * leg's endpoints OR its selected stops, so the stored route always reflects the
 * detours the user asked for.
 *
 * No-op (returns false) for rest legs or legs missing endpoint coordinates. On a
 * Directions failure it leaves the existing values untouched (a stop edit
 * shouldn't blow away a good route over a transient API hiccup) and returns
 * false. Returns true when it updated the leg.
 */
export async function rerouteLeg(legId: string): Promise<boolean> {
  const rows = await db.select().from(legs).where(eq(legs.id, legId)).limit(1);
  const leg = rows[0];
  if (!leg) return false;
  if ((leg.legType ?? 'drive') === 'rest') return false;
  if (
    leg.startLat == null ||
    leg.startLng == null ||
    leg.endLat == null ||
    leg.endLng == null
  ) {
    return false;
  }

  const waypoints = await selectedWaypointsForLeg(legId);
  const dir = await getDirections(
    { lat: leg.startLat, lng: leg.startLng },
    { lat: leg.endLat, lng: leg.endLng },
    waypoints.length > 0 ? { waypoints } : {},
  );
  if (!dir.ok || dir.polyline_points.length === 0) return false;

  await db
    .update(legs)
    .set({
      distanceKm: dir.distance_km,
      driveTimeMinutes: dir.drive_time_minutes,
      geometry: {
        type: 'LineString',
        // GeoJSON uses [lng, lat] order.
        coordinates: dir.polyline_points.map(([lat, lng]) => [lng, lat]),
      } satisfies GeoJSONLineString,
      updatedAt: new Date(),
    })
    .where(eq(legs.id, legId));
  return true;
}

export interface ContinuityRepairOut {
  legId: string;
  /** The stale origin we replaced (for logging). */
  fromName: string | null;
  /** The previous leg's destination we chained to. */
  toName: string | null;
  /** False when the re-route failed and we cleared the leg's distance/time. */
  rerouted: boolean;
}

/**
 * Enforce route continuity: every leg must START where the previous leg ENDED.
 *
 * This is the hard invariant behind "the plan must never jump". Penny authors a
 * new drive leg's start coordinates from the user's words ("leave Innsbruck on
 * the 7th"), but the traveler may actually be somewhere else by then (Bad
 * Kissingen, three rest days later). rebuildTripSchedule fixes rest-day count and
 * ordering but deliberately does not touch a drive leg's start, so the bad origin
 * survived and the map drew a dashed "gap" line. This closes that hole
 * deterministically — Penny can no longer leave a leg starting in the wrong place.
 *
 * For each leg whose start drifted from the previous leg's end (see
 * computeStartFixes), we:
 *   - rewrite start_lat/lng/name to the previous leg's destination,
 *   - rewrite an "A → B" title so it no longer shows the stale origin,
 *   - RE-ROUTE the leg (origin = corrected start) so distance_km /
 *     drive_time_minutes / geometry match the real drive. This matters because
 *     plan totals (computePlanSummary) and fuel math read those DB numbers — a
 *     corrected origin with a stale 638 km would silently poison the summary.
 *   - If Directions fails, we still land the corrected start but NULL the
 *     distance/time/geometry rather than keep numbers from the wrong origin, AND
 *     write a human-readable `continuity_warning` on the leg (via
 *     resolveContinuityRoute) so the route-less card explains itself. The caller
 *     also logs it — the failure is surfaced in two places, never swallowed.
 *
 * Self-healing: a leg that previously failed its re-route keeps its warning and
 * is already contiguous, so computeStartFixes won't re-flag it. We therefore
 * also re-attempt routing for any leg that still carries a continuity_warning
 * (from its existing, already-correct origin); if the route comes back this run
 * the warning clears. So this is NOT a strict no-op on an already-contiguous
 * trip when a warned leg exists — it makes one Directions call per warned leg.
 * Otherwise idempotent. Run after rebuildTripSchedule so it sees the settled
 * order.
 */
export async function repairLegContinuity(
  tripId: string,
): Promise<ContinuityRepairOut[]> {
  const legRows = await db
    .select()
    .from(legs)
    .where(eq(legs.tripId, tripId))
    .orderBy(asc(legs.sortOrder));
  if (legRows.length < 2) return [];

  // When the driver has reported progress, the current leg is the chain's
  // origin — its start is their real position. We must not "repair" it back to
  // the previous (completed) leg's end, and we leave the behind-you legs alone.
  const tripProgressRows = await db
    .select({ currentLegId: trips.currentLegId })
    .from(trips)
    .where(eq(trips.id, tripId))
    .limit(1);
  const currentLegId = tripProgressRows[0]?.currentLegId ?? null;
  const anchorIndex = currentLegId
    ? Math.max(0, legRows.findIndex((l) => l.id === currentLegId))
    : 0;

  const chain: ContinuityLeg[] = legRows.map((l) => ({
    legType: (l.legType ?? 'drive') === 'rest' ? 'rest' : 'drive',
    startLat: l.startLat,
    startLng: l.startLng,
    endLat: l.endLat,
    endLng: l.endLng,
    endName: l.endName,
  }));

  const fixes = computeStartFixes(chain, undefined, anchorIndex);
  const fixedIndices = new Set(fixes.map((f) => f.index));

  // Self-heal: a leg whose start was already chained on a previous run but whose
  // re-route then failed carries a continuity_warning and null geometry. It is
  // now contiguous, so computeStartFixes won't flag it again — yet the failure
  // may have been transient (a Directions blip). Re-attempt routing for those
  // legs from their existing (already-correct) origin so a recovered route can
  // clear the warning instead of leaving the leg permanently route-less.
  interface RepairTarget {
    index: number;
    /** Re-route origin. */
    originLat: number;
    originLng: number;
    originName: string | null;
    /** True for drift fixes: also persist the corrected start coords/name/title. */
    applyStart: boolean;
  }
  const targets: RepairTarget[] = fixes.map((f) => ({
    index: f.index,
    originLat: f.startLat,
    originLng: f.startLng,
    originName: f.startName,
    applyStart: true,
  }));
  for (let i = anchorIndex + 1; i < legRows.length; i++) {
    if (fixedIndices.has(i)) continue;
    const l = legRows[i];
    if (l.continuityWarning == null) continue;
    if (l.startLat == null || l.startLng == null || l.endLat == null || l.endLng == null) continue;
    targets.push({
      index: i,
      originLat: l.startLat,
      originLng: l.startLng,
      originName: l.startName,
      applyStart: false,
    });
  }
  if (targets.length === 0) return [];

  const out: ContinuityRepairOut[] = [];
  for (const target of targets) {
    const leg = legRows[target.index];
    const set: Record<string, unknown> = { updatedAt: new Date() };

    if (target.applyStart) {
      set.startLat = target.originLat;
      set.startLng = target.originLng;
      set.startName = target.originName;
      // Rewrite an "A → B" title so the displayed origin matches the new start.
      if (leg.title.includes('→') && target.originName) {
        const dest = leg.endName ?? leg.title.split('→').slice(1).join('→').trim();
        set.title = `${target.originName} → ${dest}`;
      }
    }

    let outcome: ContinuityRouteOutcome = { ok: false };
    if (leg.endLat != null && leg.endLng != null) {
      // Preserve any drive-through waypoints when re-routing from the new origin.
      const waypoints = await selectedWaypointsForLeg(leg.id);
      const dir = await getDirections(
        { lat: target.originLat, lng: target.originLng },
        { lat: leg.endLat, lng: leg.endLng },
        waypoints.length > 0 ? { waypoints } : {},
      );
      if (dir.ok && dir.polyline_points.length > 0) {
        outcome = {
          ok: true,
          distanceKm: dir.distance_km,
          driveTimeMinutes: dir.drive_time_minutes,
          geometry: {
            type: 'LineString',
            // GeoJSON uses [lng, lat] order.
            coordinates: dir.polyline_points.map(([lat, lng]) => [lng, lat]),
          } satisfies GeoJSONLineString,
        };
      }
    }

    // Decide what to persist (pure). On success we adopt the fresh route and
    // clear any warning; on failure we clear the stale distance/time/geometry
    // and record a plain-language warning so the broken leg is never silent.
    const persist = resolveContinuityRoute(outcome, target.originName, leg.endName);
    set.distanceKm = persist.distanceKm;
    set.driveTimeMinutes = persist.driveTimeMinutes;
    set.geometry = persist.geometry;
    set.continuityWarning = persist.continuityWarning;

    await db.update(legs).set(set).where(eq(legs.id, leg.id));
    out.push({
      legId: leg.id,
      fromName: leg.startName,
      toName: target.originName,
      rerouted: persist.rerouted,
    });
  }

  return out;
}

/**
 * Deep-copy a template trip into a new trip owned by `userId`. Returns the new trip id.
 * Copies legs, costs, links, routes, route_links, tasks, gpx trails, pois.
 * Chat history is NOT copied.
 */
export async function cloneTrip(sourceTripId: string, userId: string): Promise<string> {
  const src = await db.select().from(trips).where(eq(trips.id, sourceTripId)).limit(1);
  if (src.length === 0) throw new Error('Source trip not found');
  const s = src[0];

  return await db.transaction(async (tx) => {
    // Find an available "(copy)" / "(copy 2)" / "(copy N)" suffix. The unique
    // index on (user_id, trip_name_ci_key) means a naive "(copy)" suffix
    // would crash the second time the same template is cloned. Probing inside
    // the transaction reduces (but doesn't eliminate) the race; the DB unique
    // index on (user_id, trip_name_ci_key) is the actual backstop.
    let newName = `${s.name} (copy)`;
    for (let i = 1; i < 100; i++) {
      const candidate = i === 1 ? `${s.name} (copy)` : `${s.name} (copy ${i})`;
      const taken = await tx
        .select({ id: trips.id })
        .from(trips)
        .where(
          and(
            eq(trips.userId, userId),
            eq(trips.tripNameCiKey, candidate.trim().toLowerCase()),
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
        // Carry the source's machine date forward so the clone honors the
        // non-null start_date_parsed invariant (the old clone path left it null
        // and relied on a later reparse). Fall back to today defensively.
        startDateParsed: s.startDateParsed ?? todayISO(),
        endDateParsed: s.endDateParsed ?? null,
        status: 'planning',
        isTemplate: false,
        preferAvoidHighways: s.preferAvoidHighways,
      })
      .returning();
    const newTripId = newTrip.id;

    const srcLegs = await tx.select().from(legs).where(eq(legs.tripId, sourceTripId));
    const legIdMap = new Map<string, string>();
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
      const routeIdMap = new Map<string, string>();
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

// ── GPS position ────────────────────────────────────────────────────────────

export async function updateTripPosition(
  tripId: string,
  lat: number,
  lng: number,
  place: string | null = null,
) {
  await db
    .update(trips)
    .set({
      lastKnownLat: lat,
      lastKnownLng: lng,
      // Only overwrite the stored label when the caller resolved one — a failed
      // reverse-geocode shouldn't wipe a previously good name.
      ...(place != null ? { lastKnownPlace: place } : {}),
      positionUpdatedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(trips.id, tripId));
}

/**
 * Record the driver's declared tank state (the `declare_fuel_state` Penny
 * tool): "I can drive ~X km from the start of leg Y before needing fuel."
 * Finn's tank math uses it as the remaining-range baseline at that leg's
 * start (see resolveDeclaredTankAnchor in server/fuel.ts). Overwrites any
 * previous declaration — the newest statement wins.
 */
export async function setDeclaredFuelState(
  tripId: string,
  input: { remainingRangeKm: number; legId: string },
) {
  await db
    .update(trips)
    .set({
      declaredRangeKm: input.remainingRangeKm,
      declaredRangeLegId: input.legId,
      declaredRangeAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(trips.id, tripId));
}

/**
 * Pick the leg the driver should drive NEXT given a position, when the caller
 * didn't name one. Strategy: find the leg whose start/end is closest to the
 * position, then return the first drive leg at or after it. Falls back to the
 * first drive leg. Returns null when the trip has no drive legs.
 */
function resolveNextDriveLeg(
  position: { lat: number; lng: number },
  legRows: Array<typeof legs.$inferSelect>,
): string | null {
  const driveIdx = legRows
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => (l.legType ?? 'drive') !== 'rest');
  if (driveIdx.length === 0) return null;

  let nearest = 0;
  let bestKm = Infinity;
  for (let i = 0; i < legRows.length; i++) {
    const l = legRows[i];
    for (const pt of [
      { lat: l.startLat, lng: l.startLng },
      { lat: l.endLat, lng: l.endLng },
    ]) {
      if (pt.lat == null || pt.lng == null) continue;
      const km = haversineKm(position.lat, position.lng, pt.lat, pt.lng);
      if (km < bestKm) {
        bestKm = km;
        nearest = i;
      }
    }
  }
  // The first drive leg at or after the nearest leg is the one still ahead.
  const next = driveIdx.find(({ i }) => i >= nearest) ?? driveIdx[driveIdx.length - 1];
  return next.l.id;
}

/**
 * Record the driver's real-world progress: set the current-leg anchor + position,
 * re-point the upcoming leg to start where they actually are, and re-anchor the
 * calendar so the remaining legs run from now. This is the deterministic core
 * behind the `report_position` Penny tool — the lever for "I'm in Zürich, didn't
 * reach Innsbruck, continuing tomorrow".
 *
 * The caller (dispatcher) runs rebuildTripSchedule + repairLegContinuity
 * afterwards; repairLegContinuity reads `currentLegId` and pins the current leg's
 * start (the real position) instead of chaining it back to the prior leg.
 */
export async function applyTripProgress(input: {
  tripId: string;
  lat: number;
  lng: number;
  placeName?: string | null;
  /** Leg the driver will drive next; resolved from position when omitted. */
  nextLegId?: string | null;
  /** ISO date the next leg should fall on (e.g. "tomorrow"); defaults to today. */
  resumeDateISO?: string | null;
}): Promise<{ currentLegId: string | null; reroutedLeg: boolean }> {
  const legRows = await db
    .select()
    .from(legs)
    .where(eq(legs.tripId, input.tripId))
    .orderBy(asc(legs.sortOrder));

  // Resolve the owner's timezone so the anchor-date fallback ("today" when no
  // explicit resume date) lands on the driver's wall-clock day, not the server's
  // UTC day — the off-by-one that collapsed the current day into "behind you".
  const ownerTzRows = await db
    .select({ timezone: users.timezone })
    .from(trips)
    .innerJoin(users, eq(trips.userId, users.id))
    .where(eq(trips.id, input.tripId))
    .limit(1);
  const ownerTz = ownerTzRows[0]?.timezone ?? null;

  let nextLegId: string | null = null;
  if (input.nextLegId && legRows.some((l) => l.id === input.nextLegId)) {
    nextLegId = input.nextLegId;
  } else {
    nextLegId = resolveNextDriveLeg({ lat: input.lat, lng: input.lng }, legRows);
  }

  let reroutedLeg = false;
  if (nextLegId) {
    const leg = legRows.find((l) => l.id === nextLegId)!;
    if ((leg.legType ?? 'drive') !== 'rest') {
      // Re-point the upcoming drive to start from the real position, then
      // re-route so distance/time/geometry reflect the actual remaining drive.
      const set: Record<string, unknown> = {
        startLat: input.lat,
        startLng: input.lng,
        updatedAt: new Date(),
      };
      if (input.placeName) {
        set.startName = input.placeName;
        const dest = leg.endName ?? (leg.title.includes('→')
          ? leg.title.split('→').slice(1).join('→').trim()
          : null);
        if (dest) set.title = `${input.placeName} → ${dest}`;
      }
      await db.update(legs).set(set).where(eq(legs.id, nextLegId));
      reroutedLeg = await rerouteLeg(nextLegId);
    }
  }

  await db
    .update(trips)
    .set({
      currentLegId: nextLegId,
      currentLat: input.lat,
      currentLng: input.lng,
      // Keep the GPS mirror in sync so the nightly replan agrees with chat.
      lastKnownLat: input.lat,
      lastKnownLng: input.lng,
      positionUpdatedAt: new Date(),
      progressAnchorDate: input.resumeDateISO ?? todayISOInZone(ownerTz),
      progressUpdatedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(trips.id, input.tripId));

  return { currentLegId: nextLegId, reroutedLeg };
}

// ── Leg constraints ─────────────────────────────────────────────────────────

export async function addLegConstraint(input: {
  legId: string;
  constraintType: ConstraintType;
  constraintDatetime?: string | null;
  bufferMinutes?: number;
  note?: string | null;
}): Promise<LegConstraint> {
  const [row] = await db
    .insert(legConstraints)
    .values({
      legId: input.legId,
      constraintType: input.constraintType,
      constraintDatetime: input.constraintDatetime
        ? new Date(input.constraintDatetime)
        : null,
      bufferMinutes: input.bufferMinutes ?? 60,
      note: input.note ?? null,
    })
    .returning();
  return legConstraintRow(row);
}

export async function deleteLegConstraint(constraintId: string) {
  await db.delete(legConstraints).where(eq(legConstraints.id, constraintId));
}

export async function getConstraintsForLeg(legId: string): Promise<LegConstraint[]> {
  const rows = await db
    .select()
    .from(legConstraints)
    .where(eq(legConstraints.legId, legId))
    .orderBy(asc(legConstraints.createdAt));
  return rows.map(legConstraintRow);
}

/**
 * Get all constraints for all legs in a trip, grouped by leg ID.
 */
export async function getConstraintsForTrip(
  tripId: string,
): Promise<Map<string, LegConstraint[]>> {
  const rows = await db
    .select({ lc: legConstraints })
    .from(legConstraints)
    .innerJoin(legs, eq(legConstraints.legId, legs.id))
    .where(eq(legs.tripId, tripId))
    .orderBy(asc(legConstraints.createdAt));

  const map = new Map<string, LegConstraint[]>();
  for (const { lc } of rows) {
    const arr = map.get(lc.legId) || [];
    arr.push(legConstraintRow(lc));
    map.set(lc.legId, arr);
  }
  return map;
}

