export type OnboardingState =
  | 'not_started'
  | 'vehicle_pick'
  | 'vehicle_new'
  | 'preferences'
  | 'ready'
  | 'done';

export interface Trip {
  id: number;
  name: string;
  start_date: string | null;
  end_date: string | null;
  status: string;
  onboarding_state: OnboardingState;
  created_at: string;
  updated_at: string;
  user_id: string;
  vehicle_id: number | null;
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

export interface Leg {
  id: number;
  trip_id: number;
  sort_order: number;
  title: string;
  label: string | null;
  start_name: string | null;
  end_name: string | null;
  start_lat: number | null;
  start_lng: number | null;
  end_lat: number | null;
  end_lng: number | null;
  dates: string | null;
  distance_km: number | null;
  drive_time_minutes: number | null;
  terrain: string | null;
  overnight: string | null;
  status: string;
  color: string | null;
  notes: string | null; // JSON array
  fuel_status: FuelStatus;
  created_at: string;
  updated_at: string;
}

export interface Cost {
  id: number;
  leg_id: number;
  item: string;
  estimate: string;
  is_total: boolean;
}

export interface POI {
  id: number;
  leg_id: number | null;
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
  id: number;
  leg_id: number | null;
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
  id: number;
  leg_id: number;
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
  id: number;
  trip_id: number;
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
  id: number;
  leg_id: number;
  sort_order: number;
  label: string;
  description: string | null;
  distance_km: number | null;
  surface: string | null;
  status: string;
  gpx_trail_id: number | null;
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
  id: number;
  route_id: number;
  label: string;
  url: string;
  type: RouteLinkType;
}

export interface RouteWithLinks extends Route {
  links: RouteLink[];
}

export type StopType = 'fuel' | 'water' | 'food' | 'overnight' | 'rest' | 'other';
export type StopStatus = 'option' | 'selected' | 'dismissed';
export type StopSource =
  | 'penny'
  | 'user'
  | 'google_places'
  | 'osm'
  | 'manual';
export type FuelType = 'diesel' | 'petrol' | 'premium' | 'lpg';

export interface Stop {
  id: number;
  leg_id: number;
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
  created_at: string;
  updated_at: string;
}

export type TaskStatus = 'open' | 'answered' | 'dismissed';
export type TaskPriority = 'low' | 'normal' | 'high';
export type TaskCreator = 'user' | 'penny';

export interface Task {
  id: number;
  trip_id: number;
  leg_id: number | null;
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
