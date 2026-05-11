import {
  pgTable,
  text,
  integer,
  serial,
  bigserial,
  bigint,
  boolean,
  doublePrecision,
  timestamp,
  primaryKey,
  index,
  uniqueIndex,
  jsonb,
} from 'drizzle-orm/pg-core';
import type { AdapterAccountType } from 'next-auth/adapters';

// ============================================================================
// Auth.js (NextAuth v5) — Drizzle adapter standard schema
// ============================================================================

export const users = pgTable('users', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  name: text('name'),
  email: text('email').unique(),
  emailVerified: timestamp('emailVerified', { mode: 'date' }),
  image: text('image'),
  // Silently set at sign-in for the hardcoded admin allowlist. Never trust
  // session.user.email alone — always cross-check this flag against the
  // hardcoded ADMIN_ALLOWLIST in src/server/auth/admin.ts.
  isAdmin: boolean('is_admin').default(false).notNull(),
  // 'metric' | 'imperial' once the user chooses (Settings or onboarding).
  // NULL = not chosen yet — first trip shows units_pick. Existing rows keep
  // a value after migration; new signups omit this column until onboarding.
  unitsPref: text('units_pref'),
  /** When true, owning at least one vehicle fails profile completeness → trip workspace shows remediation. */
  needsVehicleProfileRemediation: boolean('needs_vehicle_profile_remediation')
    .default(false)
    .notNull(),
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

// OTP codes for email sign-in. A 6-digit numeric code is generated when the
// user submits their email on /login and emailed via Resend. The user enters
// it on /login/verify; on success the code is deleted and a session is created.
// Codes expire after 10 minutes; after 5 failed attempts the code is invalidated.
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

// ============================================================================
// Application schema
// ============================================================================

// Vehicle profile — intentionally narrow.
//
// We used to capture make/model, dimensions, full fuel breakdown
// (spec + real-world economy + tank + fuel type + timing preference), and
// fresh/black-water capacities. In practice almost none of that drove a real
// planning decision — the only thing the fuel planner actually needed was an
// "effective range between fuel stops" number, derived from
// `(real_world_kmpl ?? fuel_economy_kmpl) × fuel_tank_l × 0.8`. Migration
// 0007 collapses the lot into a single user-stated `refill_distance_km` ("I
// like to refuel every ~X km") and asks the user directly. That's both
// closer to how overlanders actually reason about refueling and dramatically
// shorter to fill in during onboarding.
export const vehicles = pgTable(
  'vehicles',
  {
    id: serial('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    isDefault: boolean('is_default').default(false).notNull(),
    // User-stated refuel cadence: how far they want to drive between fuel
    // stops, in kilometers. Used directly by the auto fuel planner as the
    // effective range. NULL = no preference set yet (planner skips this
    // vehicle until the user fills it in). Always stored in km regardless
    // of users.units_pref — the UI converts on display/input.
    refillDistanceKm: integer('refill_distance_km'),
    // Drive limits
    maxDriveHoursPerDay: doublePrecision('max_drive_hours_per_day'),
    maxDriveHoursPerWeek: doublePrecision('max_drive_hours_per_week'),
    maxConsecutiveDriveDays: integer('max_consecutive_drive_days'),
    // Water (just the cadence — no tank capacities. Penny treats these as
    // intervals between visits to a freshwater tap and to a dump station.)
    waterRefillDays: integer('water_refill_days'),
    blackwaterRefillDays: integer('blackwater_refill_days'),
    /**
     * Null = caravan/water gate not answered; remediation + onboarding ask.
     * False = skip water cadence rows; True = enforce both water refill integers.
     */
    waterTrackingEnabled: boolean('water_tracking_enabled'),
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
    id: serial('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    vehicleId: integer('vehicle_id').references(() => vehicles.id, { onDelete: 'set null' }),
    name: text('name').notNull(),
    /**
     * DB-maintained: GENERATED ALWAYS AS (lower(trim(name))) STORED (migration 0015).
     * Omitted on insert; used for case-insensitive unique trip names per user without an expression index (drizzle-kit #3062).
     */
    tripNameCiKey: text('trip_name_ci_key'),
    startDate: text('start_date'),
    endDate: text('end_date'),
    status: text('status').default('planning').notNull(),
    isTemplate: boolean('is_template').default(false).notNull(),
    // Tracks where the user is in the pre-Penny vehicle/preferences setup.
    // 'not_started' — trip just created, nothing asked yet
    // 'vehicle_pick' — user has vehicles on file; chat is asking "which one?"
    // 'vehicle_new' — collecting new-vehicle fields in chat
    // 'preferences' — collecting trip-level prefs (pace, fuel-stop cadence, etc.)
    // 'ready' — last static question ("where do you want to go?") is active
    // 'done' — handed off to Anthropic; chat is live replanning
    onboardingState: text('onboarding_state').default('not_started').notNull(),
    /**
     * User wants Google Directions routes that omit motorways (Maps `avoid=highways`).
     * Penny merges this with explicit `get_route.avoid`; does not imply gravel-only.
     */
    preferAvoidHighways: boolean('prefer_avoid_highways').default(false).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => ({
    userIdx: index('trips_user_idx').on(t.userId),
    templateIdx: index('trips_template_idx').on(t.isTemplate),
    // Trip names are unique per user, case-insensitive, ignoring surrounding
    // whitespace. Enforced at the DB layer via trip_name_ci_key + unique index
    // (migrations 0005, 0015) as a backstop for assertTripNameAvailable().
    userNameUnique: uniqueIndex('trips_user_name_unique_idx').on(t.userId, t.tripNameCiKey),
  })
);

export const legs = pgTable(
  'legs',
  {
    id: serial('id').primaryKey(),
    tripId: integer('trip_id')
      .notNull()
      .references(() => trips.id, { onDelete: 'cascade' }),
    sortOrder: integer('sort_order').notNull(),
    title: text('title').notNull(),
    label: text('label'),
    // Two-level grouping ("leg = user-stated destination jump, day = driving
    // day inside it"). Each leg row is a *driving day* in user terms; the
    // segment_* columns optionally tag which user-stated leg this day belongs
    // to. Null on both = ungrouped (flat list rendering). When set, all
    // consecutive driving days that share a segment_index render under one
    // header in the UI. segment_name is what the user actually said
    // ("Girona → Berlin"); segment_index gives a stable ordering inside the
    // trip without depending on string comparisons.
    //
    // Backwards compatible: legs predating this column have NULL on both,
    // and the UI falls back to the flat-list rendering for those trips.
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
    // Lifecycle of the auto-fuel-stop computation for this leg.
    // 'none'     — no fuel planning requested (e.g. short leg, or vehicle has no fuel data)
    // 'pending'  — queued, waiting for the worker
    // 'computing'— Google Places lookup in flight (UI shows a spinner)
    // 'ready'    — fuel stops have been inserted into `stops`
    // 'failed'   — lookup errored; UI should surface a retry affordance
    fuelStatus: text('fuel_status').default('none').notNull(),
    /** Last planFuelStopsForLeg error; cleared when status is not failed. */
    fuelPlanError: text('fuel_plan_error'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => ({
    tripIdx: index('legs_trip_idx').on(t.tripId),
  })
);

export const costs = pgTable(
  'costs',
  {
    id: serial('id').primaryKey(),
    legId: integer('leg_id')
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
    id: serial('id').primaryKey(),
    legId: integer('leg_id').references(() => legs.id, { onDelete: 'cascade' }),
    tripId: integer('trip_id')
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
    id: serial('id').primaryKey(),
    legId: integer('leg_id')
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
    id: serial('id').primaryKey(),
    legId: integer('leg_id').references(() => legs.id, { onDelete: 'cascade' }),
    tripId: integer('trip_id')
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
    id: serial('id').primaryKey(),
    legId: integer('leg_id')
      .notNull()
      .references(() => legs.id, { onDelete: 'cascade' }),
    sortOrder: integer('sort_order').default(0).notNull(),
    label: text('label').notNull(),
    description: text('description'),
    distanceKm: doublePrecision('distance_km'),
    surface: text('surface'),
    status: text('status').default('option').notNull(),
    gpxTrailId: integer('gpx_trail_id').references(() => gpxTrails.id, { onDelete: 'set null' }),
    // Per-route destination: when a route represents an overnight option, the
    // end coords here override the leg's end_lat/end_lng so tapping "Go"
    // navigates to that specific spot. Null for routes that share the leg
    // destination (e.g. plain road-route options).
    endLat: doublePrecision('end_lat'),
    endLng: doublePrecision('end_lng'),
    endName: text('end_name'),
    endSource: text('end_source'), // 'google_places'|'manual' (legacy 'ioverlander'|'park4night' rows were migrated to 'manual' in 0003)
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
    id: serial('id').primaryKey(),
    routeId: integer('route_id')
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

// First-class per-leg stops (fuel, water, food, overnight, rest, other). Routes
// describe HOW you drive the leg; stops describe WHERE you pause along it. The
// selected stops (status='selected') become waypoints in the leg's generated
// Google Maps directions URL.
export const stops = pgTable(
  'stops',
  {
    id: serial('id').primaryKey(),
    legId: integer('leg_id')
      .notNull()
      .references(() => legs.id, { onDelete: 'cascade' }),
    sortOrder: integer('sort_order').default(0).notNull(),
    stopType: text('stop_type').notNull(), // 'fuel'|'water'|'food'|'overnight'|'rest'|'other'
    status: text('status').default('option').notNull(), // 'option'|'selected'|'dismissed'
    name: text('name').notNull(),
    lat: doublePrecision('lat'),
    lng: doublePrecision('lng'),
    // Kilometers from the start of the leg (not from the previous stop).
    // Computed by Penny or the caller; used to sort waypoints and to display
    // fuel stops along the vehicle's effective range.
    distanceFromStartKm: doublePrecision('distance_from_start_km'),
    notes: text('notes'),
    // Fuel-specific helpers (ignored for non-fuel stops).
    fuelType: text('fuel_type'), // 'diesel'|'petrol'|'premium'|'lpg'|null
    fuelAmountL: doublePrecision('fuel_amount_l'),
    // Provenance
    source: text('source'), // 'penny'|'user'|'google_places'|'osm' (legacy 'ioverlander'|'park4night' rows were migrated to 'manual' in 0003)
    sourceUrl: text('source_url'),
    // Up to 2 alternate candidates for this stop, persisted by the auto-fuel
    // planner so the UI can offer a swap dropdown without re-querying Google
    // Places. Shape: [{ name, lat, lng, place_id, distance_km }]. Null when
    // there are no alternates (user-authored stops, water/food types, etc.).
    // Used by /api/stops/:id/swap-primary to atomically swap a stop's
    // primary fields with one of its alternates.
    alternatives: jsonb('alternatives').$type<StopAlternative[]>(),
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
    id: serial('id').primaryKey(),
    tripId: integer('trip_id')
      .notNull()
      .references(() => trips.id, { onDelete: 'cascade' }),
    legId: integer('leg_id').references(() => legs.id, { onDelete: 'cascade' }),
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
    id: serial('id').primaryKey(),
    tripId: integer('trip_id')
      .notNull()
      .references(() => trips.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    content: text('content').notNull(),
    changesMade: text('changes_made'),
    // Distinguishes the deterministic onboarding form from live Anthropic
    // chat, so the UI can render them differently and so we don't accidentally
    // feed form-question/answer rows back into Anthropic as conversation history.
    // 'form_question' — static Penny question during onboarding
    // 'form_answer'   — user's typed/selected answer to a form_question
    // 'ai'            — live Anthropic chat (both user + assistant turns)
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

// Records every billable external API call (Anthropic, etc.) so we can surface
// a usage + cost estimate in the admin dashboard and rate-limit per user.
export const usageEvents = pgTable(
  'usage_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    tripId: integer('trip_id').references(() => trips.id, { onDelete: 'set null' }),
    provider: text('provider').notNull(), // 'anthropic' | 'google_directions' | etc
    model: text('model'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    requests: integer('requests').default(1).notNull(),
    costMicrocents: bigint('cost_microcents', { mode: 'number' }), // 1¢ = 1,000,000 microcents
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

// Foreground time aggregate by viewport band (mobile / tablet / desktop), same
// breakpoints as src/lib/useMediaQuery.ts. Upserted from the client reporter.
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
