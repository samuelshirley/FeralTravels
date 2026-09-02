import {
  pgTable,
  pgEnum,
  text,
  integer,
  serial,
  bigserial,
  bigint,
  boolean,
  date,
  doublePrecision,
  timestamp,
  primaryKey,
  index,
  uniqueIndex,
  jsonb,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type { AdapterAccountType } from 'next-auth/adapters';
import type { SubscriptionSource, SubscriptionStatus } from '@/types/entitlement';

export type { SubscriptionSource, SubscriptionStatus };

// ── Shared JSONB types ──────────────────────────────────────────────────────

/** GeoJSON LineString — stored as JSONB on legs for driving route geometry. */
export interface GeoJSONLineString {
  type: 'LineString';
  coordinates: [number, number][]; // [lng, lat] pairs
}

/** Photo persisted on a stop at planning time (avoids Places API calls during viewing). */
export interface StopPhoto {
  url: string;
  attribution: string;
  width_px: number;
  height_px: number;
}

/**
 * Drizzle schema — single Postgres source of truth.
 *
 * Domain: `users` own `vehicles` and `trips`. A trip has `legs`; each leg has
 * `routes` (path options), `stops` (waypoints), plus `costs` / `links`. Trip-wide:
 * `pois`, `gpx_trails`, `tasks`, `chat_history`. `usage_events` + `user_viewport_time`
 * feed ops/analytics. `app_meta` is misc key/value (e.g. one-off migrations).
 *
 * Auth: NextAuth adapter tables + `email_otp_codes` for magic-link codes.
 */

export const users = pgTable('users', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  name: text('name'),
  email: text('email').unique(),
  emailVerified: timestamp('emailVerified', { mode: 'date' }),
  image: text('image'),
  /** Mirrors admin allowlist at sign-in; never infer admin from email alone. */
  isAdmin: boolean('is_admin').default(false).notNull(),
  /**
   * Free forever: the author's account and the E2E fixtures. Skips the paywall
   * AND the usage cap, but still writes `usage_events` — comping the spend out
   * of existence would falsify the very numbers the pricing was derived from.
   *
   * Set from an allowlist at sign-in, exactly like `isAdmin` above, and for the
   * same reason: an entitlement check that string-matches an email is one typo
   * away from comping every address at a domain.
   */
  comped: boolean('comped').default(false).notNull(),
  /**
   * When this account first finished trip onboarding — vehicle supplied, range
   * set, handed off to Penny. Null means they never have.
   *
   * `trips.onboarding_state` already tracks this PER TRIP, and that stays the
   * thing the wizard reads. This is the USER-level fact, and it exists because
   * seeding could not check the one that mattered: a fixture wrote a trip full
   * of legs onto an account that owned no vehicle, which is a pairing the app
   * itself cannot produce, so nothing in the app noticed. A seeded account can
   * now be asked the same question a real one answers.
   */
  onboardingCompletedAt: timestamp('onboarding_completed_at'),
  /** `'metric' | 'imperial'` — null until the user picks units (onboarding / settings). */
  unitsPref: text('units_pref'),
  /**
   * IANA timezone (e.g. "Europe/Oslo"), captured from the browser on load.
   * Null until first captured → server falls back to UTC. The single source of
   * truth for what "today" is *for this user*: leg-date anchoring, Penny's
   * context.today, and the report_position anchor all resolve through it so the
   * server's notion of the current day matches the driver's wall clock.
   */
  timezone: text('timezone'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const accounts = pgTable(
  'accounts',
  {
    userId: text('userId')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: text('type').$type<AdapterAccountType>().notNull(),
    provider: text('provider').notNull(),
    providerAccountId: text('providerAccountId').notNull(),
    refresh_token: text('refresh_token'),
    access_token: text('access_token'),
    expires_at: integer('expires_at'),
    token_type: text('token_type'),
    scope: text('scope'),
    id_token: text('id_token'),
    session_state: text('session_state'),
  },
  (account) => ({
    pk: primaryKey({ columns: [account.provider, account.providerAccountId] }),
    // The composite PK is (provider, providerAccountId), so `userId` is
    // unindexed and the delete cascade would seq-scan. Same reasoning as
    // sessions_user_idx.
    userIdx: index('accounts_user_idx').on(account.userId),
  })
);

export const sessions = pgTable(
  'sessions',
  {
    sessionToken: text('sessionToken').primaryKey(),
    userId: text('userId')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expires: timestamp('expires', { mode: 'date' }).notNull(),
  },
  (t) => ({
    // Postgres does NOT index a foreign key automatically. Without this, the
    // ON DELETE CASCADE fired by account deletion has to seq-scan the whole
    // sessions table — inside the deletion transaction. See the note on
    // `usage_events.trip_id` below for the failure mode this class of missing
    // index produces.
    userIdx: index('sessions_user_idx').on(t.userId),
  })
);

export const verificationTokens = pgTable(
  'verificationTokens',
  {
    identifier: text('identifier').notNull(),
    token: text('token').notNull(),
    expires: timestamp('expires', { mode: 'date' }).notNull(),
  },
  (vt) => ({
    pk: primaryKey({ columns: [vt.identifier, vt.token] }),
  })
);

/** Email OTP for /login — short-lived, attempt-limited; see `server/auth/otp.ts`. */
export const emailOtpCodes = pgTable(
  'email_otp_codes',
  {
    id: serial('id').primaryKey(),
    email: text('email').notNull(),
    code: text('code').notNull(),
    expires: timestamp('expires', { mode: 'date' }).notNull(),
    attempts: integer('attempts').default(0).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => ({
    emailIdx: index('otp_email_idx').on(t.email),
  })
);

/**
 * One row per native OAuth ID token that has been redeemed at
 * /api/mobile/oauth/exchange. Two jobs, one table:
 *
 *  - REPLAY: `tokenHash` is the primary key, so redeeming the same provider
 *    token twice is a unique-constraint miss rather than a second session.
 *    Provider ID tokens live ~1h and the iOS client id ships inside the app
 *    binary, so a captured token was otherwise good for unlimited 30-day
 *    sessions until it expired.
 *  - RATE LIMIT: `email` + `usedAt` let the route cap how many exchanges one
 *    address can drive in a window, in the same DB-backed way the OTP
 *    cooldown works (in-memory counters are useless across serverless
 *    invocations).
 *
 * `expires` is the TOKEN's own exp, not a session lifetime — rows are only
 * useful until the token they guard would be rejected anyway, and the route
 * prunes past-expiry rows opportunistically.
 *
 * Stores a SHA-256 of the token, never the token itself: the raw JWT is a
 * bearer credential and this table has no business holding one.
 */
export const oauthTokenUses = pgTable(
  'oauth_token_uses',
  {
    tokenHash: text('token_hash').primaryKey(),
    email: text('email').notNull(),
    usedAt: timestamp('used_at').defaultNow().notNull(),
    expires: timestamp('expires', { mode: 'date' }).notNull(),
  },
  (t) => ({
    emailUsedAtIdx: index('oauth_token_uses_email_used_at_idx').on(t.email, t.usedAt),
    expiresIdx: index('oauth_token_uses_expires_idx').on(t.expires),
  })
);

// --- Enums ─────────────────────────────────────────────────────────────────

export const tripStatusEnum = pgEnum('trip_status', [
  'draft',
  'active',
  'paused',
  'completed',
]);

export const constraintTypeEnum = pgEnum('constraint_type', [
  'arrive_by',
  'depart_after',
  'flexible',
]);

// --- Trip planning (per-user) ---

/** Vehicle profile: refill cadence + drive/water caps; distances stored in km. */
export const vehicles = pgTable(
  'vehicles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    isDefault: boolean('is_default').default(false).notNull(),
    /**
     * Driving range between fills (km) — how far the driver is
     * *happy* to go before refuelling. The everyday planning target Finn aims
     * for. Null ⇒ planner skips until set (not-yet-onboarded only).
     */
    rangeKm: integer('range_km'),

    /**
     * Vehicle fuel — 'diesel' | 'petrol'. Drives which per-fuel price Finn
     * fetches from regional feeds / Google fuelOptions. Defaults to 'diesel'
     * (overlander norm) when null; editable in Settings.
     */
    fuelType: text('fuel_type'),

    // MVP vehicle profile is just name + fuel range. Travel
    // style, driving-cadence (max_consecutive_drive_days / rest_days_after_driving)
    // and dump-station tracking were all removed in the onboarding teardown; the
    // planner caps each driving day at DEFAULT_MAX_DRIVE_HOURS_PER_DAY
    // (vehicleProfile.ts).
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => ({
    userIdx: index('vehicles_user_idx').on(t.userId),
  })
);

export const trips = pgTable(
  'trips',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    vehicleId: uuid('vehicle_id').references(() => vehicles.id, { onDelete: 'set null' }),
    name: text('name').notNull(),
    /** DB-generated `lower(trim(name))`; unique per user via index (see baseline migration). */
    tripNameCiKey: text('trip_name_ci_key'),
    /** Free-text dates (original columns — may contain "May 28", "late May", etc.). */
    startDate: text('start_date'),
    endDate: text('end_date'),
    /**
     * Machine-readable start date for cron/constraint/leg-date logic. Hard
     * non-null invariant: createTrip seeds a today placeholder and the forced
     * onboarding `trip_date` question sets the real value. Defaults to
     * CURRENT_DATE at the DB level as a final backstop against direct inserts.
     */
    startDateParsed: date('start_date_parsed', { mode: 'string' })
      .notNull()
      .default(sql`CURRENT_DATE`),
    /** Machine-readable end date (still optional — many trips are open-ended). */
    endDateParsed: date('end_date_parsed', { mode: 'string' }),
    status: text('status').default('planning').notNull(),
    /** Trip lifecycle status for nightly replan gating. */
    tripStatus: tripStatusEnum('trip_status').default('draft').notNull(),
    isTemplate: boolean('is_template').default(false).notNull(),
    /** Static onboarding pipeline before live Penny chat (`server/onboarding.ts`). */
    onboardingState: text('onboarding_state').default('not_started').notNull(),
    /** Stores the user's trip description during onboarding, before the LLM is called. Cleared after handoff. */
    pendingIntent: text('pending_intent'),
    /**
     * Validated onboarding values transcribed from the opening message by the
     * first-message intent scan that can't be applied immediately (fuel-range
     * safety numbers awaiting confirmation on the vehicle step). Prefilled there,
     * then cleared at handoff. Mirror of `pending_intent`. See `OnboardingScan`.
     */
    onboardingScan: jsonb('onboarding_scan').$type<import('@/types/trip').OnboardingScan | null>(),
    /** Maps option avoid highways; merged with tool-level avoid flags. */
    preferAvoidHighways: boolean('prefer_avoid_highways').default(false).notNull(),
    // ── GPS position (device location, refreshed each time the app opens) ──
    // This is the driver's *device* location from the browser Geolocation API,
    // distinct from the driver-reported progress anchor below. It's what powers
    // "plan from my current location" — Penny reads it from context. `lastKnownPlace`
    // is a client-side reverse-geocoded label (via the already-loaded Maps JS
    // Geocoder) so Penny/UI can show a name instead of raw coordinates.
    lastKnownLat: doublePrecision('last_known_lat'),
    lastKnownLng: doublePrecision('last_known_lng'),
    lastKnownPlace: text('last_known_place'),
    positionUpdatedAt: timestamp('position_updated_at'),
    // ── Driver-reported trip progress (see the `report_position` Penny tool) ──
    // `currentLegId` is the leg the driver is on / about to drive next; legs
    // before it in sort order are "behind you" (completed). `progressAnchorDate`
    // is the ISO date that leg should fall on, which re-anchors every remaining
    // leg's calendar date (getTripFull). Stored as a plain uuid (no FK) so a
    // deleted leg just leaves a stale pointer the next report overwrites.
    currentLegId: uuid('current_leg_id'),
    currentLat: doublePrecision('current_lat'),
    currentLng: doublePrecision('current_lng'),
    progressAnchorDate: date('progress_anchor_date', { mode: 'string' }),
    progressUpdatedAt: timestamp('progress_updated_at'),
    // ── Declared tank state (the `declare_fuel_state` Penny tool) ──────────
    // The driver's own statement of how far they can drive from the START of
    // `declaredRangeLegId` before needing fuel ("I only have ~150 km in the
    // tank"). Finn's tank math treats it as the remaining-range baseline at
    // that leg's start, overriding the "full tank at trip start" assumption.
    // A real fuel stop between the anchor and the leg being planned supersedes
    // it (refuel resets the tank). Plain uuid anchor, no FK — same rationale
    // as `currentLegId`: a deleted leg leaves a stale pointer that is simply
    // ignored (anchor resolution checks the leg still exists on this trip).
    declaredRangeKm: doublePrecision('declared_range_km'),
    declaredRangeLegId: uuid('declared_range_leg_id'),
    declaredRangeAt: timestamp('declared_range_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => ({
    userIdx: index('trips_user_idx').on(t.userId),
    templateIdx: index('trips_template_idx').on(t.isTemplate),
    userNameUnique: uniqueIndex('trips_user_name_unique_idx').on(t.userId, t.tripNameCiKey),
    tripStatusIdx: index('trips_trip_status_idx').on(t.tripStatus),
  })
);

export const legs = pgTable(
  'legs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tripId: uuid('trip_id')
      .notNull()
      .references(() => trips.id, { onDelete: 'cascade' }),
    sortOrder: integer('sort_order').notNull(),
    /**
     * 'drive' = a driving day (the original leg type).
     * 'rest'  = a non-driving rest/stop day at a location.
     * Default 'drive' for backward compatibility with existing legs.
     */
    legType: text('leg_type').default('drive').notNull(),
    title: text('title').notNull(),
    label: text('label'),
    /** Optional multi-day grouping header (`segment_name` + stable `segment_index`). */
    segmentIndex: integer('segment_index'),
    segmentName: text('segment_name'),
    startName: text('start_name'),
    endName: text('end_name'),
    startLat: doublePrecision('start_lat'),
    startLng: doublePrecision('start_lng'),
    endLat: doublePrecision('end_lat'),
    endLng: doublePrecision('end_lng'),
    dates: text('dates'),
    distanceKm: doublePrecision('distance_km'),
    driveTimeMinutes: integer('drive_time_minutes'),
    terrain: text('terrain'),
    overnight: text('overnight'),
    status: text('status').default('planning').notNull(),
    color: text('color'),
    notes: text('notes'),
    /** Auto fuel planner: none | pending | computing | ready | failed | no_stations_found — see `server/fuel.ts`. */
    fuelStatus: text('fuel_status').default('none').notNull(),
    fuelPlanError: text('fuel_plan_error'),
    /**
     * Lazy fuel cache timestamp. Set when a real fuel search completes for this
     * leg (`ready` / `no_stations_found`); null when never sourced or
     * invalidated. The day-open lazy loader (`planFuelStopsForLegLazy`) renders
     * straight from cache when this is within `FUEL_CACHE_TTL_MS`, and only
     * re-searches once it goes stale. Cleared by `invalidateLegFuelCache` when a
     * leg edit / report_position changes the route. See `server/fuel.ts`.
     */
    fuelStopsUpdatedAt: timestamp('fuel_stops_updated_at'),
    /**
     * Set by repairLegContinuity when it chained this leg's start to the prior
     * leg's end but the re-route then failed, so distance/time/geometry were
     * cleared. A human-readable reason the leg renders without a route — kept so
     * the failure is never silent (see `resolveContinuityRoute` in
     * `lib/penny/schedule.ts`). Null when the leg routes cleanly.
     */
    continuityWarning: text('continuity_warning'),
    /**
     * Driving route geometry stored as GeoJSON LineString (from Google Directions).
     * Persisted at planning time so the UI never calls external APIs during viewing.
     */
    geometry: jsonb('geometry').$type<GeoJSONLineString | null>(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => ({
    tripIdx: index('legs_trip_idx').on(t.tripId),
  })
);

/**
 * Constraints on legs — deadlines, earliest departures, or flexible intent.
 * Supports multiple constraints per leg (e.g., ferry window = arrive_by + depart_after).
 */
export const legConstraints = pgTable(
  'leg_constraints',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    legId: uuid('leg_id')
      .notNull()
      .references(() => legs.id, { onDelete: 'cascade' }),
    constraintType: constraintTypeEnum('constraint_type').notNull(),
    /** The actual deadline or earliest departure. Null for `flexible` constraints. */
    constraintDatetime: timestamp('constraint_datetime', { withTimezone: true }),
    /** Slack before/after the constraint datetime, in minutes. */
    bufferMinutes: integer('buffer_minutes').default(60).notNull(),
    /** User-facing context, e.g. "ferry departs at 2pm", "meet friends". */
    note: text('note'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => ({
    legIdx: index('leg_constraints_leg_idx').on(t.legId),
  })
);

export const costs = pgTable(
  'costs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    legId: uuid('leg_id')
      .notNull()
      .references(() => legs.id, { onDelete: 'cascade' }),
    item: text('item').notNull(),
    estimate: text('estimate').notNull(),
    isTotal: boolean('is_total').default(false).notNull(),
  },
  (t) => ({
    legIdx: index('costs_leg_idx').on(t.legId),
  })
);

export const pois = pgTable(
  'pois',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    legId: uuid('leg_id').references(() => legs.id, { onDelete: 'cascade' }),
    tripId: uuid('trip_id')
      .notNull()
      .references(() => trips.id, { onDelete: 'cascade' }),
    source: text('source').notNull(),
    externalId: text('external_id'),
    name: text('name').notNull(),
    lat: doublePrecision('lat').notNull(),
    lng: doublePrecision('lng').notNull(),
    type: text('type'),
    description: text('description'),
    rating: doublePrecision('rating'),
    url: text('url'),
    data: text('data'),
    lastVerified: timestamp('last_verified'),
    status: text('status').default('active').notNull(),
  },
  (t) => ({
    tripIdx: index('pois_trip_idx').on(t.tripId),
    legIdx: index('pois_leg_idx').on(t.legId),
  })
);

export const links = pgTable(
  'links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    legId: uuid('leg_id')
      .notNull()
      .references(() => legs.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    url: text('url').notNull(),
    type: text('type').default('general').notNull(),
  },
  (t) => ({
    legIdx: index('links_leg_idx').on(t.legId),
  })
);

export const gpxTrails = pgTable(
  'gpx_trails',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    legId: uuid('leg_id').references(() => legs.id, { onDelete: 'cascade' }),
    tripId: uuid('trip_id')
      .notNull()
      .references(() => trips.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    filename: text('filename').notNull(),
    source: text('source'),
    sourceUrl: text('source_url'),
    distanceKm: doublePrecision('distance_km'),
    surface: text('surface'),
    verified: boolean('verified').default(false).notNull(),
    notes: text('notes'),
  },
  (t) => ({
    tripIdx: index('gpx_trip_idx').on(t.tripId),
    legIdx: index('gpx_leg_idx').on(t.legId),
  })
);

export const routes = pgTable(
  'routes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    legId: uuid('leg_id')
      .notNull()
      .references(() => legs.id, { onDelete: 'cascade' }),
    sortOrder: integer('sort_order').default(0).notNull(),
    label: text('label').notNull(),
    description: text('description'),
    distanceKm: doublePrecision('distance_km'),
    surface: text('surface'),
    status: text('status').default('option').notNull(),
    gpxTrailId: uuid('gpx_trail_id').references(() => gpxTrails.id, { onDelete: 'set null' }),
    /** Optional route-specific destination (e.g. alternate overnight); overrides leg end when set. */
    endLat: doublePrecision('end_lat'),
    endLng: doublePrecision('end_lng'),
    endName: text('end_name'),
    endSource: text('end_source'),
    endSourceUrl: text('end_source_url'),
    driveTimeMinutes: integer('drive_time_minutes'),
  },
  (t) => ({
    legIdx: index('routes_leg_idx').on(t.legId),
  })
);

export const routeLinks = pgTable(
  'route_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    routeId: uuid('route_id')
      .notNull()
      .references(() => routes.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    url: text('url').notNull(),
    type: text('type').default('other').notNull(),
  },
  (t) => ({
    routeIdx: index('route_links_route_idx').on(t.routeId),
  })
);

/** Leg waypoints (fuel/water/food/overnight/…); `selected` rows feed Maps URLs. */
export const stops = pgTable(
  'stops',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    legId: uuid('leg_id')
      .notNull()
      .references(() => legs.id, { onDelete: 'cascade' }),
    sortOrder: integer('sort_order').default(0).notNull(),
    stopType: text('stop_type').notNull(),
    status: text('status').default('option').notNull(),
    name: text('name').notNull(),
    lat: doublePrecision('lat'),
    lng: doublePrecision('lng'),
    distanceFromStartKm: doublePrecision('distance_from_start_km'),
    notes: text('notes'),
    fuelType: text('fuel_type'),
    fuelAmountL: doublePrecision('fuel_amount_l'),
    source: text('source'),
    sourceUrl: text('source_url'),
    /** Fuel-stop alternates for swap UI (`StopAlternative[]`). */
    alternatives: jsonb('alternatives').$type<StopAlternative[]>(),
    /** Google Place ID — enables direct link construction without extra API calls. */
    placeId: text('place_id'),
    /** Direct Google Maps link — persisted at planning time. */
    googleMapsUri: text('google_maps_uri'),
    /** Photos fetched from Places API at planning time — avoids API calls during viewing. */
    photos: jsonb('photos').$type<StopPhoto[]>(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => ({
    legIdx: index('stops_leg_idx').on(t.legId),
  })
);

/** One alternate gas station / rest stop candidate for a `stops` row. */
export interface StopAlternative {
  name: string;
  lat: number;
  lng: number;
  place_id: string | null;
  distance_km: number;
}

export const tasks = pgTable(
  'tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tripId: uuid('trip_id')
      .notNull()
      .references(() => trips.id, { onDelete: 'cascade' }),
    legId: uuid('leg_id').references(() => legs.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    description: text('description'),
    priority: text('priority').default('normal').notNull(),
    status: text('status').default('open').notNull(),
    referenceUrl: text('reference_url'),
    referenceLabel: text('reference_label'),
    referencePhone: text('reference_phone'),
    answer: text('answer'),
    answerSourceUrl: text('answer_source_url'),
    answerImageUrl: text('answer_image_url'),
    createdBy: text('created_by').default('user').notNull(),
    dueAt: timestamp('due_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => ({
    tripIdx: index('tasks_trip_idx').on(t.tripId),
    legIdx: index('tasks_leg_idx').on(t.legId),
  })
);

export const chatHistory = pgTable(
  'chat_history',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Auto-incrementing sequence for cursor-based pagination (ORDER BY seq DESC). */
    seq: serial('seq').notNull(),
    tripId: uuid('trip_id')
      .notNull()
      .references(() => trips.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    content: text('content').notNull(),
    changesMade: text('changes_made'),
    /**
     * Deterministic, DB-derived plan facts snapshotted when this assistant turn
     * landed (day counts, depart/arrive dates, totals, deadline check). The
     * UI renders these instead of trusting numbers in Penny's prose — see
     * `computePlanSummary` and the PlanSummary type. Null on non-schedule turns.
     */
    planSummary: jsonb('plan_summary').$type<import('@/types/trip').PlanSummary | null>(),
    /** `form_question` | `form_answer` | `ai` — onboarding vs live chat. */
    kind: text('kind').default('ai').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => ({
    tripIdx: index('chat_trip_idx').on(t.tripId),
  })
);

export const appMeta = pgTable('app_meta', {
  key: text('key').primaryKey(),
  value: text('value'),
});

/** Billable API usage (Anthropic, Directions, …) — admin + accounting. */
export const usageEvents = pgTable(
  'usage_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    tripId: uuid('trip_id').references(() => trips.id, { onDelete: 'set null' }),
    provider: text('provider').notNull(),
    model: text('model'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    /** Prompt-cache write tokens (billed 1.25× base input). Null on non-Anthropic + historical rows. */
    cacheCreationInputTokens: integer('cache_creation_input_tokens'),
    /** Prompt-cache read tokens (billed 0.10× base input). Null on non-Anthropic + historical rows. */
    cacheReadInputTokens: integer('cache_read_input_tokens'),
    requests: integer('requests').default(1).notNull(),
    /** Stored in microcents (1¢ = 1_000_000). */
    costMicrocents: bigint('cost_microcents', { mode: 'number' }),
    success: boolean('success').default(true).notNull(),
    errorMessage: text('error_message'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => ({
    userIdx: index('usage_user_idx').on(t.userId),
    createdIdx: index('usage_created_idx').on(t.createdAt),
    providerIdx: index('usage_provider_idx').on(t.provider),
    /**
     * The referential action behind `trip_id`'s ON DELETE SET NULL runs once per
     * DELETED PARENT ROW, so deleting an account with N trips ran N unindexed
     * UPDATEs over the largest and fastest-growing table in the schema — inside
     * the deletion transaction. A heavy user could time out the function, abort
     * the transaction and be left unable to delete their account on any retry:
     * the failure would land hardest on exactly the people with the most data.
     */
    tripIdx: index('usage_trip_idx').on(t.tripId),
  })
);

/** Client-reported active seconds per viewport band (`useMediaQuery` breakpoints). */
export const userViewportTime = pgTable(
  'user_viewport_time',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    viewport: text('viewport').notNull().$type<'mobile' | 'tablet' | 'desktop'>(),
    totalSeconds: bigint('total_seconds', { mode: 'number' }).notNull(),
    updatedAt: timestamp('updated_at', { mode: 'date' }).defaultNow().notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.viewport] }),
    userIdx: index('user_viewport_time_user_idx').on(t.userId),
  })
);

// ── Announcements ───────────────────────────────────────────────────────────

/**
 * One-time announcements / update notices shown to users on login.
 * Admin creates rows via /admin/announcements; users dismiss them once.
 */
export const announcements = pgTable('announcements', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** Short title shown at the top of the modal. */
  title: text('title').notNull(),
  /** Body text — the main message. */
  body: text('body').notNull(),
  /** Label on the dismiss button (e.g. "Wow nice job Sam"). */
  buttonText: text('button_text').notNull().default('Got it'),
  /** Only active announcements are shown; flip to false to retire. */
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

/** Tracks which users have dismissed which announcements (one row = dismissed). */
export const announcementDismissals = pgTable(
  'announcement_dismissals',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    announcementId: uuid('announcement_id')
      .notNull()
      .references(() => announcements.id, { onDelete: 'cascade' }),
    dismissedAt: timestamp('dismissed_at').defaultNow().notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.announcementId] }),
    userIdx: index('announcement_dismissals_user_idx').on(t.userId),
  })
);

// ── Penny turns ─────────────────────────────────────────────────────────────

/** Lifecycle of one Penny replan turn. */
export type PennyTurnStatus = 'queued' | 'running' | 'done' | 'error';

/**
 * One row per Penny replan turn — the durable record of a chat turn's lifecycle,
 * independent of the SSE stream the client reads.
 *
 * Why it exists: the chat stream rides a fetch the browser tears down whenever the
 * PWA is backgrounded mid-turn. The server keeps running and persists Penny's reply
 * regardless (Vercel request cancellation is opt-in and off here), but the client
 * only saw a thrown error. This record lets a dropped client RE-ATTACH and reconcile
 * (heal the false "Something went wrong" bubble) instead of dead-ending, gives the
 * server an idempotency anchor so a retry/double-send can't spawn two concurrent
 * replans on one trip, and persists a QUEUED turn so it survives the app closing and
 * runs after the in-flight turn finishes. See docs/design/penny-turn-resilience.md.
 */
export const pennyTurns = pgTable(
  'penny_turns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tripId: uuid('trip_id')
      .notNull()
      .references(() => trips.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Client-generated, stable per send — dedupes retries of the same turn. */
    idempotencyKey: text('idempotency_key').notNull(),
    status: text('status')
      .notNull()
      .default('running')
      .$type<PennyTurnStatus>(),
    /** The user's message text — kept so a queued turn can run later. */
    userMessage: text('user_message').notNull(),
    /** Images attached to the turn (data URLs), so a queued turn can replay them. */
    images: jsonb('images').$type<{ dataUrl: string; mediaType: string }[] | null>(),
    /** Penny's final prose once `done`. */
    resultResponse: text('result_response'),
    /** Terminal `applied` payload (counts, planSummary, …) for client reconcile. */
    resultMeta: jsonb('result_meta').$type<Record<string, unknown> | null>(),
    /** Real error text when `status = 'error'`. */
    errorMessage: text('error_message'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => ({
    keyIdx: uniqueIndex('penny_turns_idempotency_key_idx').on(t.idempotencyKey),
    tripIdx: index('penny_turns_trip_idx').on(t.tripId),
    // Indexed by trip but not by user, so the user cascade seq-scanned.
    userIdx: index('penny_turns_user_idx').on(t.userId),
    tripStatusIdx: index('penny_turns_trip_status_idx').on(t.tripId, t.status),
    // At most ONE `running` turn per trip — the DB-enforced execution slot.
    // Promoting a queued turn to `running` while another is running raises a
    // unique violation, which the repo catches to keep the loser queued. This
    // closes the check-then-insert TOCTOU (two distinct concurrent sends can no
    // longer both start a replan on one trip). Partial: queued/done/error rows
    // are unconstrained, so a backlog of `queued` turns is still allowed.
    oneRunningPerTripIdx: uniqueIndex('penny_turns_one_running_per_trip_idx')
      .on(t.tripId)
      .where(sql`${t.status} = 'running'`),
  })
);

/**
 * Tombstone for a deleted account — the ONLY thing that survives a deletion.
 *
 * Account deletion is a hard delete: the `users` row is removed and every FK in
 * this schema cascades from it, so trips, legs, stops, routes, chat history,
 * vehicles, sessions and OAuth accounts all go with it. `usage_events` is the
 * deliberate exception (`user_id` is `set null`, not cascade) so AI-spend and
 * error history stay intact but anonymous.
 *
 * This table exists so two questions stay answerable after the fact:
 *   1. "Did this address ever have an account here?" — `email_hash` is a keyed
 *      (HMAC) digest of the lowercased address, so a candidate email can be
 *      hashed and matched without the table ever holding a readable address, and
 *      without the digest being guessable offline from a table dump.
 *   2. "Who is churning, and how far did they get before quitting?" — the
 *      counts plus `account_created_at` → `deleted_at` give the trial-then-leave
 *      picture, and `email_encrypted` lets an admin read the actual address.
 *
 * `email_encrypted` is AES-256-GCM under `DELETED_USER_ENC_KEY`, which lives in
 * the Vercel env and NOT in the database — a dump of this table alone reveals no
 * addresses. Decryption happens only behind the admin allowlist. The column is
 * nullable on purpose: if the key is missing or malformed the deletion still
 * completes and simply stores the hash. A user's right to delete must never
 * depend on our bookkeeping succeeding.
 *
 * NOT unique on `email_hash` — someone can sign up, delete, sign up again and
 * delete again, and each deletion is its own event worth counting.
 */
export const deletedUsers = pgTable(
  'deleted_users',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    /**
     * HMAC-SHA256 of the lowercased, trimmed email, keyed with the same env
     * secret as `email_encrypted` (bare SHA-256 only when no key is set).
     * One-way: matchable against a candidate address, never reversible.
     */
    emailHash: text('email_hash').notNull(),
    /** AES-256-GCM ciphertext (`v1:<iv>:<tag>:<data>`, base64 parts). Null when no key configured. */
    emailEncrypted: text('email_encrypted'),
    /** `'google' | 'apple' | 'otp'` etc. — which provider(s) the account had linked. */
    signInProviders: text('sign_in_providers'),
    /** When the account was originally created — pairs with `deletedAt` to give tenure. */
    accountCreatedAt: timestamp('account_created_at'),
    /** How much they had built before quitting. Cheap churn signal, no PII. */
    tripCount: integer('trip_count').default(0).notNull(),
    vehicleCount: integer('vehicle_count').default(0).notNull(),
    chatMessageCount: integer('chat_message_count').default(0).notNull(),
    /** `'self'` today; leaves room for `'admin'` / `'support'` later. */
    deletedBy: text('deleted_by').default('self').notNull(),
    deletedAt: timestamp('deleted_at').defaultNow().notNull(),
  },
  (t) => ({
    hashIdx: index('deleted_users_email_hash_idx').on(t.emailHash),
    deletedAtIdx: index('deleted_users_deleted_at_idx').on(t.deletedAt),
  })
);

// ── Promo codes ─────────────────────────────────────────────────────────────

/**
 * One row per code handed out by an admin. Redeeming writes a `subscriptions`
 * row with `source: 'promo'` — this table does NOT answer "is this account
 * entitled", and nothing in the paywall path reads it.
 *
 * That separation is the whole design. `hasEntitlement` stays the one question
 * with one answer, `resolveAccountState` needs no new branch, and a promo user
 * is visible in the admin panel as what they are: a subscriber whose row says
 * where it came from. A second entitlement source would have meant a second
 * place able to decide someone has paid, which is exactly what
 * `src/server/payments/index.ts` exists to prevent.
 *
 * ── Why the code is stored in plaintext ──
 *
 * `deleted_users` HMACs its email column because CI puts a clone of production
 * behind a PUBLIC preview URL and a bare digest of an enumerable value could be
 * attacked offline from a dump. The reasoning does not carry over here, and it
 * is worth saying why rather than cargo-culting it.
 *
 * A code is useless without the account it is bound to. Redemption requires a
 * signed-in session whose email matches `email` on this row, and signing in as
 * that address requires receiving a code at it. So a leaked code grants nothing
 * to the person who leaked it — it is not a bearer token. What plaintext does
 * expose is "an admin issued a code to alice@example.com", and a preview clone
 * already exposes every address in `users` wholesale, so this adds no class of
 * disclosure that is not already there.
 *
 * The thing plaintext buys is real: the admin can re-read a code they issued
 * three weeks ago when the recipient says they lost the email. A hashed column
 * makes that impossible and the support answer becomes "here is a new code",
 * which is worse for a mechanism whose entire job is hand-holding early users.
 */
export const promoCodes = pgTable(
  'promo_codes',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    /**
     * Normalized on the way in: uppercase, no separators. `FERAL-4KQP-8XZM`
     * and `feral4kqp8xzm` are the same code, because the recipient is typing
     * this off a message on a phone.
     */
    code: text('code').notNull(),
    /**
     * The address this code was minted FOR, lowercased. Redemption compares the
     * session's own email against it and refuses a mismatch — a code is not
     * transferable, which is what stops one being forwarded around a group
     * chat.
     */
    email: text('email').notNull(),
    /** Free text for the admin's own memory: who this is, why they got it. */
    note: text('note'),
    /** Admin address that minted it. Never null — every grant has an author. */
    createdBy: text('created_by').notNull(),
    /**
     * Deadline to REDEEM. NOT the length of the access it grants — that is
     * `grantMonths` below, and the two being confusable is the reason both
     * carry this warning. Null means the code never goes stale.
     */
    expiresAt: timestamp('expires_at'),
    /**
     * How long the access lasts, in months, counted from REDEMPTION.
     *
     * 6 or 12 — validated in the Zod schema on `POST /api/admin/promo`, not
     * here, because a check constraint on an integer column is a migration
     * every time the owner wants a third option.
     *
     * NOT counted from minting. A six-month code minted today and redeemed in
     * three weeks would otherwise be five months and a week of a gift meant as
     * six, with nothing telling anybody. `expiresAt` is the control for "use it
     * or lose it"; this is the control for "how much".
     *
     * Promo grants used to be unlimited (`current_period_end = null`). They are
     * now a real term, and `resolveAccountState` expires them for free: its
     * `periodOver` branch already treats an `active` row with a past
     * `current_period_end` as `expired`, on the principle that the clock is the
     * authority and not a stale status.
     */
    grantMonths: integer('grant_months').notNull(),
    /** Set once, by the atomic claim. Non-null means spent — codes are single-use. */
    redeemedAt: timestamp('redeemed_at'),
    /**
     * `set null`, not `cascade`: if the user later deletes their account, the
     * record that a code was issued and spent must survive them. Deleting the
     * evidence would make a spent code look mintable again.
     */
    redeemedByUserId: text('redeemed_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => ({
    /**
     * UNIQUE, and it is load-bearing rather than tidiness: it is what makes the
     * generator's collision check unnecessary and what stops two rows ever
     * answering to the same string.
     */
    codeUnique: uniqueIndex('promo_codes_code_idx').on(t.code),
    emailIdx: index('promo_codes_email_idx').on(t.email),
    /** The admin list is ordered by this, and it is the only sort it offers. */
    createdAtIdx: index('promo_codes_created_at_idx').on(t.createdAt),
  })
);

// ── Subscriptions ───────────────────────────────────────────────────────────

/**
 * `SubscriptionStatus` and `SubscriptionSource` are defined in
 * `src/types/entitlement.ts`, not here, because the Expo app needs the same
 * vocabulary and `scripts/sync-shared.mjs` can only mirror `@/types`.
 * Re-exported so existing `from '@/server/db/schema'` imports keep working.
 */
export const subscriptions = pgTable(
  'subscriptions',
  {
    userId: text('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: text('status').$type<SubscriptionStatus>().notNull(),
    source: text('source').$type<SubscriptionSource>().notNull(),
    /** Store product id, e.g. `com.feraltravels.app.monthly`. Null for admin grants. */
    productId: text('product_id'),
    /**
     * When paid access ends. Null means "no end" — an admin comp or a lifetime
     * promo. A null here with an entitled status is unlimited access, so the
     * admin UI must show it as such rather than as a blank cell.
     */
    currentPeriodEnd: timestamp('current_period_end'),
    /** Apple's stable id for the subscription across renewals. The join key for ASSN. */
    originalTransactionId: text('original_transaction_id'),
    /** False once the user turns off auto-renew. Does NOT itself remove access. */
    autoRenew: boolean('auto_renew').default(true).notNull(),
    /** Set by the break-glass revoke. Both are required by the admin UI when it is used. */
    revokedAt: timestamp('revoked_at'),
    revokedBy: text('revoked_by'),
    revokedReason: text('revoked_reason'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => ({
    statusIdx: index('subscriptions_status_idx').on(t.status),
    originalTxIdx: index('subscriptions_original_tx_idx').on(t.originalTransactionId),
  })
);

/**
 * Every webhook event we have ever accepted, keyed on the store's own event id.
 *
 * This table IS the idempotency mechanism: the handler inserts here first with
 * `onConflictDoNothing`, and a zero-row result means "already processed, stop".
 * Apple and RevenueCat both retry, so a handler that is merely careful rather
 * than idempotent will double-apply in production, not in theory.
 *
 * `eventTimeMs` is the store's timestamp, not ours, and it is what makes
 * out-of-order delivery safe: a `DID_RENEW` that was delayed in flight and
 * arrives after a `REFUND` carries an older `eventTimeMs`, so the handler can
 * refuse to let it resurrect access.
 */
export const subscriptionEvents = pgTable(
  'subscription_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    /** The store's event id. Unique — this is the whole point of the table. */
    eventId: text('event_id').notNull(),
    /** Null when the event names a user we do not have (logged, not fatal). */
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    /** Raw notification type, e.g. `INITIAL_PURCHASE`, `REFUND`, `DID_RENEW`. */
    type: text('type').notNull(),
    /** The store's own event timestamp in epoch ms. Orders events; ours does not. */
    eventTimeMs: bigint('event_time_ms', { mode: 'number' }),
    /** The verbatim payload, so a mis-handled event can be re-read later. */
    payload: jsonb('payload'),
    /**
     * `applied` | `ignored_duplicate` | `ignored_stale` | `ignored_unknown_type`
     * | `ignored_unknown_user` | `error`.
     *
     * `ignored_unknown_user` is kept distinct from `ignored_unknown_type` on
     * purpose: "the store sent a type we don't handle" is routine, and
     * "somebody paid us and we cannot find their account" is not.
     */
    outcome: text('outcome').notNull(),
    receivedAt: timestamp('received_at').defaultNow().notNull(),
  },
  (t) => ({
    eventIdUnique: uniqueIndex('subscription_events_event_id_idx').on(t.eventId),
    userIdx: index('subscription_events_user_idx').on(t.userId),
  })
);

/**
 * One row per (user, threshold) the moment that threshold is first crossed.
 *
 * Exists purely so the alert email fires ONCE. Without it, every blocked
 * request re-sends it, and a single capped user mails support a hundred times
 * in an afternoon.
 */
export const usageAlerts = pgTable(
  'usage_alerts',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** `watch` ($2/12mo, admin-only) or `stop` ($8.50/12mo, user is blocked). */
    threshold: text('threshold').$type<'watch' | 'stop'>().notNull(),
    /** The 12-month Anthropic total at the moment it fired, for the email and the audit. */
    microcentsAtFiring: bigint('microcents_at_firing', { mode: 'number' }),
    firedAt: timestamp('fired_at').defaultNow().notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.threshold] }),
  })
);
