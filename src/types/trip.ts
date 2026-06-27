export type OnboardingState =
  | 'not_started'
  | 'trip_intent'
  | 'trip_date'      // forced start-date entry — must parse to a real calendar day
  | 'trip_name'      // legacy only — naming step removed; rows here are advanced on read
  | 'units_pick'
  | 'vehicle_pick'   // legacy only — no longer part of onboarding flow
  | 'vehicle_new'
  | 'range_help'     // "I don't know my range" → estimate-and-confirm interstitial
  | 'preferences'    // legacy only
  | 'ready'          // legacy only
  | 'done';

/**
 * Validated, prefill-confirm onboarding values transcribed from the driver's
 * opening message by the first-message intent scan (`server/onboardingIntentScan.ts`),
 * stashed on the trip until the question that owns each field comes up. Holds
 * only fields that are NOT applied immediately — the start date is persisted and
 * its question skipped at scan time, so it never lands here; the fuel-range
 * fields are safety numbers that must be confirmed on the vehicle step, so they
 * wait here as a prefill. All values are already validated/in-band when stored.
 * Cleared at onboarding handoff. Mirror of `pending_intent`.
 */
export interface OnboardingScan {
  /** Comfortable range (km), in-band, awaiting confirmation on the vehicle step. */
  comfortable_range_km?: number | null;
  /** Hard-max range (km), in-band, awaiting confirmation on the vehicle step. */
  hard_max_range_km?: number | null;
}

// ── Nightly replan types ──────────────────────────────────────────────────

export type TripStatus = 'draft' | 'active' | 'paused' | 'completed';

export type ConstraintType = 'arrive_by' | 'depart_after' | 'flexible';

export interface LegConstraint {
  id: string;
  leg_id: string;
  constraint_type: ConstraintType;
  /** ISO timestamp with timezone, null for `flexible` constraints. */
  constraint_datetime: string | null;
  buffer_minutes: number;
  note: string | null;
  created_at: string;
}

export interface Trip {
  id: string;
  name: string;
  /** Free-text date (original column — may be "May 28", "late May", etc.). */
  start_date: string | null;
  end_date: string | null;
  /**
   * Machine-readable start date (ISO YYYY-MM-DD). Guaranteed non-null: every
   * trip is forced through the onboarding `trip_date` question, and `createTrip`
   * seeds a today placeholder so the column is never null even mid-onboarding.
   */
  start_date_parsed: string;
  end_date_parsed: string | null;
  status: string;
  /** Trip lifecycle status for nightly replan gating. */
  trip_status: TripStatus;
  onboarding_state: OnboardingState;
  /** When true, Penny defaults `get_route` to Maps avoid=highways (motorways); user can toggle in workspace. */
  prefer_avoid_highways: boolean;
  // ── GPS position (for nightly replan) ──
  last_known_lat: number | null;
  last_known_lng: number | null;
  position_updated_at: string | null;
  // ── Driver-reported progress (see the `report_position` Penny tool) ──
  /** Leg the driver is on / about to drive next; earlier legs are "behind you". */
  current_leg_id: string | null;
  current_lat: number | null;
  current_lng: number | null;
  /** ISO date the current leg falls on — re-anchors remaining leg dates. */
  progress_anchor_date: string | null;
  progress_updated_at: string | null;
  created_at: string;
  updated_at: string;
  user_id: string;
  vehicle_id: string | null;
  is_template: boolean;
}

/**
 * Lifecycle of the per-leg auto fuel-stop computation. See schema.ts for
 * the authoritative comments; kept here so UI can show a spinner without
 * a server round-trip for meaning.
 */
export type FuelStatus =
  | 'none'
  | 'pending'
  | 'computing'
  | 'ready'
  | 'failed'
  // Planning ran fine but the route is too remote for an on-route station
  // within the widest search radius. NOT a failure — a real warning the user
  // must act on (carry extra fuel / plan a stop manually). `fuel_plan_error`
  // carries the human-readable reason. See server/fuel.ts.
  | 'no_stations_found';

/** GeoJSON LineString for driving route geometry. */
export interface GeoJSONLineString {
  type: 'LineString';
  coordinates: [number, number][]; // [lng, lat] pairs
}

export type LegType = 'drive' | 'rest';

export interface Leg {
  id: string;
  trip_id: string;
  sort_order: number;
  /** 'drive' for driving days, 'rest' for non-driving stop days. */
  leg_type: LegType;
  title: string;
  label: string | null;
  // Two-level grouping. Each leg row is a *driving day* in user terms; these
  // optional fields tag which user-stated jump (e.g. "Girona → Berlin") this
  // day belongs to. Both null = ungrouped — UI falls back to flat-list mode.
  // See drizzle/0006_legs_segment_grouping.sql for migration notes.
  segment_index: number | null;
  segment_name: string | null;
  start_name: string | null;
  end_name: string | null;
  start_lat: number | null;
  start_lng: number | null;
  end_lat: number | null;
  end_lng: number | null;
  dates: string | null;
  /**
   * Server-computed calendar date for this leg, ISO "YYYY-MM-DD". Non-null:
   * the trip's start date is a hard invariant (see Trip.start_date_parsed), so
   * every leg resolves to a calendar day. Derived as `trip.start_date_parsed +
   * leg rank` (every leg, driving or rest, occupies one calendar day). This is
   * the source of truth for leg dates — the client formats it for display and
   * must NOT recompute the date itself. See `legDateISO` in `lib/dates.ts`.
   */
  date_iso: string;
  distance_km: number | null;
  drive_time_minutes: number | null;
  terrain: string | null;
  overnight: string | null;
  status: string;
  color: string | null;
  notes: string | null; // JSON array
  fuel_status: FuelStatus;
  /** Populated when fuel_status is failed; human-readable diagnosis. */
  fuel_plan_error: string | null;
  /**
   * Lazy fuel cache timestamp (ISO) — set when a real fuel search last completed
   * for this leg, null when never sourced or invalidated. The day-open loader
   * uses it to decide cache-hit vs stale re-check (see FUEL_CACHE_TTL_MS).
   */
  fuel_stops_updated_at: string | null;
  /**
   * Set when continuity repair chained this leg's start but couldn't re-route
   * it, so distance/time/geometry were cleared. Human-readable reason the leg
   * has no route — null when the leg routes cleanly. See `resolveContinuityRoute`.
   */
  continuity_warning: string | null;
  /** Driving route geometry — GeoJSON LineString persisted at planning time. */
  geometry: GeoJSONLineString | null;
  created_at: string;
  updated_at: string;
}

export interface Cost {
  id: string;
  leg_id: string;
  item: string;
  estimate: string;
  is_total: boolean;
}

export interface POI {
  id: string;
  leg_id: string | null;
  source: string;
  external_id: string | null;
  name: string;
  lat: number;
  lng: number;
  type: string | null;
  description: string | null;
  rating: number | null;
  url: string | null;
  data: string | null;
  last_verified: string | null;
  status: string;
}

export interface GPXTrail {
  id: string;
  leg_id: string | null;
  name: string;
  filename: string;
  source: string | null;
  source_url: string | null;
  distance_km: number | null;
  surface: string | null;
  verified: boolean;
  notes: string | null;
}

export interface Link {
  id: string;
  leg_id: string;
  label: string;
  url: string;
  type: string;
}

/**
 * Distinguishes deterministic onboarding-form turns from live Anthropic chat.
 * The UI renders them identically (chat bubbles) but the client-side form
 * submitter needs to know the current row is a question it should respond to.
 */
export type ChatKind = 'ai' | 'form_question' | 'form_answer';

export interface ChatMessage {
  id: string;
  /** Sequential ordering number for cursor-based pagination. */
  seq: number;
  trip_id: string;
  role: 'user' | 'assistant';
  content: string;
  kind: ChatKind;
  changes_made: string | null;
  /**
   * Deterministic, DB-derived snapshot of the trip plan AS IT STOOD when this
   * assistant turn landed. This is the source of truth for plan facts (day
   * counts, dates, totals) shown alongside Penny's prose — Penny's text is a
   * conversational wrapper only and must NOT state these numbers itself, which
   * is how we avoid the autoregressive hallucinations (invented arrival times,
   * wrong day/night counts). Null on turns that didn't change the schedule and
   * on legacy rows written before this field existed. See `computePlanSummary`.
   */
  plan_summary: PlanSummary | null;
  created_at: string;
}

/**
 * A purely factual summary of a trip plan, computed deterministically from the
 * persisted legs (never authored by the LLM). Distances stay in km and times in
 * minutes / ISO dates so the client can format them in the user's units at
 * render time — same contract as `LegWithDetails.date_iso`.
 */
export interface PlanSummary {
  /** Total calendar days = drive days + rest days (every leg is one day). */
  total_days: number;
  drive_days: number;
  rest_days: number;
  /** ISO "YYYY-MM-DD" of the first leg, or null when the trip has no start date. */
  depart_date_iso: string | null;
  depart_name: string | null;
  /** ISO "YYYY-MM-DD" of the final driving leg (arrival), or null. */
  arrive_date_iso: string | null;
  arrive_name: string | null;
  /**
   * Assumed daily departure wall-clock time ("HH:MM", default 08:00). The plan
   * has no per-leg stored times; this is the day-model default we surface so the
   * arrival ETA is interpretable. Null when there are no driving legs.
   */
  depart_time: string | null;
  /**
   * Estimated wall-clock arrival time of the FINAL drive ("HH:MM"), from the
   * day model (departure + driving + realistic breaks). An estimate, not a
   * stored fact. Null when the final leg's drive time is unknown.
   */
  arrive_time: string | null;
  total_distance_km: number;
  total_drive_minutes: number;
  /** Waypoints with at least one night, in route order. */
  nights_per_stop: Array<{ name: string | null; nights: number }>;
  /** Present only when a drive leg carries an arrive_by constraint. */
  deadline: PlanSummaryDeadline | null;
}

/**
 * Date-only comparison of the planned arrival against a fixed arrive_by
 * constraint. We deliberately do NOT model clock time — the schedule only
 * assigns calendar dates — so we report the deadline DATE and whether arrival
 * lands before / on / after it, never an invented arrival time.
 */
export interface PlanSummaryDeadline {
  /** The constraint datetime exactly as authored (ISO 8601 with offset). */
  datetime_iso: string;
  /** Local calendar date of the deadline ("YYYY-MM-DD"), or null if unparseable. */
  date_iso: string | null;
  /** Local wall-clock time of the deadline ("HH:MM"), or null if date-only. */
  local_time: string | null;
  /** 'before' | 'same_day' | 'after' — by calendar date only. */
  status: 'before' | 'same_day' | 'after';
  /** Whole days of slack (deadline date − arrival date). 0 = same day, <0 = late. */
  buffer_days: number | null;
  /**
   * Time-of-day check for the SAME-DAY case: when arrival lands on the deadline
   * date and we know both the deadline time and the final drive time, the day
   * model estimates the arrival clock-time and the slack against the deadline.
   * Null when not a same-day comparison or times are unavailable.
   */
  same_day_clock: {
    /** Estimated arrival "HH:MM" (day model: 08:00 + drive + breaks). */
    eta: string;
    /** Raw minutes before the deadline (deadline − eta). Negative = late. */
    slack_minutes: number;
    /** True when slack clears the 1-hour buffer (slack_minutes >= 60). */
    clears_buffer: boolean;
  } | null;
}

export type RouteLinkType =
  | 'gpx'
  | 'google_maps'
  | 'wikiloc'
  | 'komoot'
  | 'gaia'
  | 'dog_park'
  | 'park'
  | 'other';

export type RouteEndSource = 'google_places' | 'manual';

export interface Route {
  id: string;
  leg_id: string;
  sort_order: number;
  label: string;
  description: string | null;
  distance_km: number | null;
  surface: string | null;
  status: string;
  gpx_trail_id: string | null;
  // Per-route destination (for overnight options). When set, "Go" navigates
  // to this point instead of the leg's end coords.
  end_lat: number | null;
  end_lng: number | null;
  end_name: string | null;
  end_source: RouteEndSource | null;
  end_source_url: string | null;
  drive_time_minutes: number | null;
}

export interface RouteLink {
  id: string;
  route_id: string;
  label: string;
  url: string;
  type: RouteLinkType;
}

export interface RouteWithLinks extends Route {
  links: RouteLink[];
}

/**
 * MVP stop types — exactly two:
 *  - 'fuel'  : gas stops found automatically by Finn along the route.
 *  - 'other' : a stop the user explicitly adds (Google Maps link, address, or
 *              place name). Selected 'other' stops force the route through them
 *              (they become &waypoints= in the leg's Google Maps URL).
 * Amenity types (food/parks) and auto overnight-stop finding were removed in
 * the MVP teardown — Penny does not proactively find anything but fuel.
 */
export type StopType = 'fuel' | 'other';
export type StopStatus = 'option' | 'selected' | 'dismissed';
export type StopSource =
  | 'penny'
  | 'user'
  | 'google_places'
  | 'osm'
  | 'manual';
export type FuelType = 'diesel' | 'petrol' | 'premium' | 'lpg';

/** Tri-state fuel price outcome for a stop — never a silent null. */
export type StopPriceState = 'priced' | 'unknown' | 'unavailable_in_country';

export interface StopAlternative {
  name: string;
  lat: number;
  lng: number;
  place_id: string | null;
  distance_km: number;
}

export interface StopPhoto {
  url: string;
  attribution: string;
  width_px: number;
  height_px: number;
}

export interface Stop {
  id: string;
  leg_id: string;
  sort_order: number;
  stop_type: StopType;
  status: StopStatus;
  name: string;
  lat: number | null;
  lng: number | null;
  distance_from_start_km: number | null;
  notes: string | null;
  fuel_type: FuelType | null;
  fuel_amount_l: number | null;
  source: StopSource | null;
  source_url: string | null;
  // Up to 2 alternate gas-station / rest-stop candidates persisted by the
  // auto-fuel planner. Null on user-authored stops, water/food types, etc.
  alternatives: StopAlternative[] | null;
  /** Google Place ID. */
  place_id: string | null;
  /** Direct Google Maps link — persisted at planning time. */
  google_maps_uri: string | null;
  /** Photos from Places API — persisted at planning time to avoid API calls during viewing. */
  photos: StopPhoto[] | null;
  /**
   * Finn fuel price (tri-state; never silently null once pricing has run):
   *  'priced' → price_per_litre + price_currency + price_as_of are set
   *  'unknown' → country covered, this station has no price
   *  'unavailable_in_country' → no price source for price_country
   * Null only when pricing hasn't run / isn't configured. See finn-fuel-agent.md.
   */
  price_state: StopPriceState | null;
  price_per_litre: number | null;
  price_currency: string | null;
  price_fuel_type: string | null;
  price_country: string | null;
  price_source: string | null;
  price_as_of: string | null;
  created_at: string;
  updated_at: string;
}

export type TaskStatus = 'open' | 'answered' | 'dismissed';
export type TaskPriority = 'low' | 'normal' | 'high';
export type TaskCreator = 'user' | 'penny';

export interface Task {
  id: string;
  trip_id: string;
  leg_id: string | null;
  title: string;
  description: string | null;
  priority: TaskPriority;
  status: TaskStatus;
  reference_url: string | null;
  reference_label: string | null;
  reference_phone: string | null;
  answer: string | null;
  answer_source_url: string | null;
  answer_image_url: string | null;
  created_by: TaskCreator;
  due_at: string | null;
  created_at: string;
  updated_at: string;
}

// Frontend-friendly types with parsed JSON fields
export interface LegWithDetails extends Leg {
  costs: Cost[];
  links: Link[];
  routes: RouteWithLinks[];
  stops: Stop[];
  tasks: Task[];
  constraints: LegConstraint[];
  parsedNotes: string[];
}

export interface TripWithLegs extends Trip {
  legs: LegWithDetails[];
}

export type LegStatus = 'planning' | 'research' | 'confirmed' | 'anchored';

export const STATUS_MAP: Record<LegStatus, { label: string; bg: string; border: string; text: string }> = {
  anchored: { label: "DATE LOCKED", bg: "rgba(198, 93, 74, 0.12)", border: "rgba(198, 93, 74, 0.4)", text: "#C65D4A" },
  confirmed: { label: "CONFIRMED", bg: "rgba(74, 139, 122, 0.12)", border: "rgba(74, 139, 122, 0.38)", text: "#4A8B7A" },
  planning: { label: "PLANNING", bg: "rgba(78, 122, 176, 0.12)", border: "rgba(78, 122, 176, 0.35)", text: "#4E7AB0" },
  research: { label: "NEEDS RESEARCH", bg: "rgba(184, 149, 106, 0.14)", border: "rgba(184, 149, 106, 0.4)", text: "#B8956A" },
};
