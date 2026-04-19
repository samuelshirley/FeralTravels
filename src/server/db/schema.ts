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

// ============================================================================
// Application schema
// ============================================================================

export const vehicles = pgTable(
  'vehicles',
  {
    id: serial('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    isDefault: boolean('is_default').default(false).notNull(),
    heightCm: integer('height_cm'),
    fuelEconomyKmpl: doublePrecision('fuel_economy_kmpl'),
    fuelTankL: doublePrecision('fuel_tank_l'),
    maxDriveHoursPerDay: doublePrecision('max_drive_hours_per_day'),
    maxDriveHoursPerWeek: doublePrecision('max_drive_hours_per_week'),
    waterRefillDays: integer('water_refill_days'),
    blackwaterRefillDays: integer('blackwater_refill_days'),
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
    startDate: text('start_date'),
    endDate: text('end_date'),
    status: text('status').default('planning').notNull(),
    isTemplate: boolean('is_template').default(false).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => ({
    userIdx: index('trips_user_idx').on(t.userId),
    templateIdx: index('trips_template_idx').on(t.isTemplate),
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
