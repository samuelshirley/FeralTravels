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
  /** True ⇒ workspace prompts until vehicle profile fields are complete. */
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

// --- Trip planning (per-user) ---

/** Vehicle profile: refill cadence + drive/water caps; distances stored in km. */
export const vehicles = pgTable(
  'vehicles',
  {
    id: serial('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    isDefault: boolean('is_default').default(false).notNull(),
    /** Target km between fuel stops; null ⇒ planner skips until set. */
    refillDistanceKm: integer('refill_distance_km'),
    maxDriveHoursPerDay: doublePrecision('max_drive_hours_per_day'),
    maxDriveHoursPerWeek: doublePrecision('max_drive_hours_per_week'),
    maxConsecutiveDriveDays: integer('max_consecutive_drive_days'),
    waterRefillDays: integer('water_refill_days'),
    blackwaterRefillDays: integer('blackwater_refill_days'),
    /** Null = not answered; false = ignore water fields; true = both integers required. */
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
    /** DB-generated `lower(trim(name))`; unique per user via index (see baseline migration). */
    tripNameCiKey: text('trip_name_ci_key'),
    startDate: text('start_date'),
    endDate: text('end_date'),
    status: text('status').default('planning').notNull(),
    isTemplate: boolean('is_template').default(false).notNull(),
    /** Static onboarding pipeline before live Penny chat (`server/onboarding.ts`). */
    onboardingState: text('onboarding_state').default('not_started').notNull(),
    /** Maps option avoid highways; merged with tool-level avoid flags. */
    preferAvoidHighways: boolean('prefer_avoid_highways').default(false).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => ({
    userIdx: index('trips_user_idx').on(t.userId),
    templateIdx: index('trips_template_idx').on(t.isTemplate),
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
    /** Auto fuel planner: none | pending | computing | ready | failed — see `server/fuel.ts`. */
    fuelStatus: text('fuel_status').default('none').notNull(),
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

/** Leg waypoints (fuel/water/food/overnight/…); `selected` rows feed Maps URLs. */
export const stops = pgTable(
  'stops',
  {
    id: serial('id').primaryKey(),
    legId: integer('leg_id')
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
    tripId: integer('trip_id').references(() => trips.id, { onDelete: 'set null' }),
    provider: text('provider').notNull(),
    model: text('model'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
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
