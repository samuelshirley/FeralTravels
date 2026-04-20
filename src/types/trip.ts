export interface Trip {
  id: number;
  name: string;
  start_date: string | null;
  end_date: string | null;
  status: string;
  created_at: string;
  updated_at: string;
  user_id: string;
  vehicle_id: number | null;
  is_template: boolean;
}

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

export interface ChatMessage {
  id: number;
  trip_id: number;
  role: 'user' | 'assistant';
  content: string;
  changes_made: string | null;
  created_at: string;
}

export type RouteLinkType =
  | 'gpx'
  | 'google_maps'
  | 'wikiloc'
  | 'komoot'
  | 'gaia'
  | 'park4night'
  | 'ioverlander'
  | 'dog_park'
  | 'other';

export type RouteEndSource = 'ioverlander' | 'park4night' | 'google_places' | 'manual';

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
  tasks: Task[];
  parsedNotes: string[];
}

export interface TripWithLegs extends Trip {
  legs: LegWithDetails[];
}

export type LegStatus = 'planning' | 'research' | 'confirmed' | 'anchored';

export const STATUS_MAP: Record<LegStatus, { label: string; bg: string; border: string; text: string }> = {
  anchored: { label: "DATE LOCKED", bg: "#2D1B0E", border: "#E8927C", text: "#E8927C" },
  confirmed: { label: "CONFIRMED", bg: "#0E2D1B", border: "#7CE8A3", text: "#7CE8A3" },
  planning: { label: "PLANNING", bg: "#1B1B2D", border: "#7CB5E8", text: "#7CB5E8" },
  research: { label: "NEEDS RESEARCH", bg: "#2D2D0E", border: "#E8D57C", text: "#E8D57C" },
};
