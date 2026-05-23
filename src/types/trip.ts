export type OnboardingState =
  | 'not_started'
  | 'trip_intent'
  | 'trip_name'
  | 'units_pick'
  | 'vehicle_pick'   // legacy only — no longer part of onboarding flow
  | 'vehicle_new'
  | 'preferences'    // legacy only
  | 'ready'          // legacy only
  | 'done';

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
  /** Machine-readable date (ISO YYYY-MM-DD). Null until user confirms a proper date. */
  start_date_parsed: string | null;
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
  | 'failed';

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
   * Server-computed calendar date for this leg, ISO "YYYY-MM-DD", or null when
   * the trip has no confirmed start date. Derived as `trip.start_date_parsed +
   * leg rank` (every leg, driving or rest, occupies one calendar day). This is
   * the source of truth for leg dates — the client formats it for display and
   * must NOT recompute the date itself. See `legDateISO` in `lib/dates.ts`.
   */
  date_iso: string | null;
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
  created_at: string;
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

export type StopType = 'fuel' | 'dump_station' | 'food' | 'overnight' | 'rest' | 'other';
export type StopStatus = 'option' | 'selected' | 'dismissed';
export type StopSource =
  | 'penny'
  | 'user'
  | 'google_places'
  | 'osm'
  | 'manual';
export type FuelType = 'diesel' | 'petrol' | 'premium' | 'lpg';

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
