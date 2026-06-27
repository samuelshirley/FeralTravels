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
  /** `'metric' | 'imperial'` — null until the user picks units (onboarding / settings). */
  unitsPref: text('units_pref'),
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
  })
);

export const sessions = pgTable('sessions', {
  sessionToken: text('sessionToken').primaryKey(),
  userId: text('userId')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  expires: timestamp('expires', { mode: 'date' }).notNull(),
});

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
     * Comfortable driving range between fills (km) — how far the driver is
     * *happy* to go before refuelling. The everyday planning target Finn aims
     * for. Null ⇒ planner skips until set (not-yet-onboarded only).
     */
    comfortableRangeKm: integer('comfortable_range_km'),
    /**
     * Hard-max driving range between fills (km) — the absolute ceiling Finn must
     * NEVER route a dry stretch past, for any price. Always ≥ comfortableRangeKm.
     * When the driver gives no separate max, it defaults to comfortableRangeKm
     * (the conservative direction — Finn simply never stretches). Null ⇒
     * not-yet-onboarded only.
     */
    hardMaxRangeKm: integer('hard_max_range_km'),

    /**
     * Vehicle fuel — 'diesel' | 'petrol'. Drives which per-fuel price Finn
     * fetches from regional feeds / Google fuelOptions. Defaults to 'diesel'
     * (overlander norm) when null; editable in Settings.
     */
    fuelType: text('fuel_type'),

    // MVP vehicle profile is just name + comfortable/hard-max range. Travel
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
    // ── GPS position (for nightly replan) ──
    lastKnownLat: doublePrecision('last_known_lat'),
    lastKnownLng: doublePrecision('last_known_lng'),
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
     * Driving route geometry stored as GeoJSON LineString (from Directions/OSRM).
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
    /**
     * Finn fuel price (tri-state, never silently null). `price_state` is the
     * source of truth for display:
     *   'priced'                 → price_per_litre + currency + as_of are set
     *   'unknown'                → country covered, this station has no price
     *   'unavailable_in_country' → no price source for price_country
     * See docs/design/finn-fuel-agent.md → "Price availability model".
     */
    priceState: text('price_state'),
    pricePerLitre: doublePrecision('price_per_litre'),
    priceCurrency: text('price_currency'),
    priceFuelType: text('price_fuel_type'),
    priceCountry: text('price_country'),
    priceSource: text('price_source'),
    priceAsOf: timestamp('price_as_of'),
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
