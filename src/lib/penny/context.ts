import 'server-only';
import { vehicleIsCompleteForRemediation } from '@/lib/vehicleProfile';
import { getTripFull } from '@/server/repos/trips';
import { getChatPage } from '@/server/repos/chat';
import {
  getDefaultVehicleForUser,
  getVehicleForUser,
  type VehicleApi,
} from '@/server/repos/vehicles';
import type { ChatMessage, LegWithDetails, TripWithLegs } from '@/types/trip';

/**
 * Shape of the structured context passed to Penny. Everything here is
 * already filtered for what Claude actually needs — we don't ship the full
 * Drizzle row. Keeping this narrow makes the prompt cheaper and easier to
 * debug when Claude hallucinates a field.
 */
export interface PennyContext {
  trip: {
    id: string;
    name: string;
    start_date: string | null;
    end_date: string | null;
    status: string;
  };
  vehicle: PennyVehicle | null;
  legs: PennyLeg[];
  recentChat: Array<{ role: 'user' | 'assistant'; content: string }>;
  /**
   * True when the driver's saved vehicle row fails strict profile completeness
   * (fuel + driving caps + caravan dump station gate). Penny must steer to Settings
   * or `/vehicle-setup` instead of implying automated fuel/routing succeeded.
   */
  vehicle_profile_blocked: boolean;
}

/**
 * Trimmed vehicle shape Penny plans against: user-stated refuel cadence +
 * drive limits + optional dump station cadence. `effective_range_km` aliases
 * `refill_distance_km` for prompts and the fuel planner.
 */
export interface PennyVehicle {
  id: string;
  name: string;
  refill_distance_km: number | null;
  /** Alias of refill_distance_km — kept for prompt/system-side stability. */
  effective_range_km: number | null;
  max_drive_hours_per_day: number | null;
  max_drive_hours_per_week: number | null;
  max_consecutive_drive_days: number | null;
  /**
   * How many non-driving (rest) days the user needs after a streak of
   * consecutive driving days. E.g. "I can drive 3 days then need 1 rest day"
   * → max_consecutive_drive_days=3, rest_days_after_driving=1.
   */
  rest_days_after_driving: number | null;
  /** Null = onboarding/remediation hasn't asked caravan gate yet. */
  dump_station_tracking_enabled: boolean | null;
  dump_station_interval_days: number | null;
}

export interface PennyLeg {
  id: string;
  sort_order: number;
  /** 'drive' for driving days, 'rest' for non-driving stop days. */
  leg_type: string;
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
  status: string;
  notes: string[];
  routes: Array<{
    id: string;
    label: string;
    status: string;
    distance_km: number | null;
    surface: string | null;
    description: string | null;
    end_name: string | null;
    end_lat: number | null;
    end_lng: number | null;
  }>;
  stops: Array<{
    id: string;
    stop_type: string;
    status: string;
    name: string;
    lat: number | null;
    lng: number | null;
    distance_from_start_km: number | null;
    fuel_type: string | null;
    fuel_amount_l: number | null;
    source: string | null;
    notes: string | null;
  }>;
  tasks: Array<{
    id: string;
    title: string;
    description: string | null;
    priority: string;
    status: string;
    reference_url: string | null;
  }>;
}

/**
 * Effective driving range between fuel stops, in kilometers.
 *
 * Migration 0007 collapsed the old fuel-economy / tank / real-world / 20% buffer
 * computation into a single user-stated `refill_distance_km` ("I like to refuel
 * every ~X km"). This helper exists so callers don't reach into the vehicle row
 * directly — if we ever add range-shaping logic (terrain modifiers, towing
 * derate, etc.) it goes here in one place. Today it's the identity function on
 * a non-positive guard.
 */
export function computeEffectiveRangeKm(
  refillDistanceKm: number | null
): number | null {
  if (refillDistanceKm == null || refillDistanceKm <= 0) return null;
  return Math.round(refillDistanceKm);
}

/**
 * Assemble everything Penny needs to plan or replan a trip: the trip skeleton,
 * the assigned vehicle (with derived range), each leg's routes / stops / tasks,
 * and the tail of the chat transcript so Penny has short-term memory.
 *
 * Anything missing (no vehicle, no chat history) gets explicit nulls / empty
 * arrays — never undefined — so the system prompt can reference the fields
 * without defensive JSON checks.
 */
export async function buildPennyContext(
  tripId: string,
  userId: string,
  options: { recentChatLimit?: number } = {}
): Promise<PennyContext | null> {
  const trip = await getTripFull(tripId);
  if (!trip) return null;

  const vehicle = await resolveVehicle(trip, userId);
  const chatPage = await getChatPage({
    tripId,
    limit: options.recentChatLimit ?? 12,
    // Only feed live chat back into Penny — onboarding form Q/A rows would
    // look like user instructions and confuse her.
    kinds: ['ai'],
  });

  const vehicle_profile_blocked =
    vehicle == null ||
    !vehicleIsCompleteForRemediation(vehicleRecordFromApiForCompleteness(vehicle));

  return {
    trip: {
      id: trip.id,
      name: trip.name,
      start_date: trip.start_date,
      end_date: trip.end_date,
      status: trip.status,
    },
    vehicle: vehicle ? projectVehicle(vehicle) : null,
    legs: trip.legs.map(projectLeg),
    recentChat: chatPage.messages.map(projectChat),
    vehicle_profile_blocked,
  };
}

function vehicleRecordFromApiForCompleteness(v: VehicleApi): Record<string, unknown> {
  return {
    name: v.name,
    refill_distance_km: v.refill_distance_km,
    max_drive_hours_per_day: v.max_drive_hours_per_day,
    max_drive_hours_per_week: v.max_drive_hours_per_week,
    max_consecutive_drive_days: v.max_consecutive_drive_days,
    dump_station_interval_days: v.dump_station_interval_days,
    dump_station_tracking_enabled: v.dump_station_tracking_enabled,
  };
}

async function resolveVehicle(trip: TripWithLegs, userId: string): Promise<VehicleApi | null> {
  if (trip.vehicle_id != null) {
    const v = await getVehicleForUser(userId, trip.vehicle_id).catch(() => null);
    if (v) return v;
  }
  return getDefaultVehicleForUser(userId).catch(() => null);
}

function projectVehicle(v: VehicleApi): PennyVehicle {
  const range = computeEffectiveRangeKm(v.refill_distance_km);
  return {
    id: v.id,
    name: v.name,
    refill_distance_km: v.refill_distance_km,
    effective_range_km: range,
    max_drive_hours_per_day: v.max_drive_hours_per_day,
    max_drive_hours_per_week: v.max_drive_hours_per_week,
    max_consecutive_drive_days: v.max_consecutive_drive_days,
    rest_days_after_driving: v.rest_days_after_driving ?? null,
    dump_station_tracking_enabled: v.dump_station_tracking_enabled ?? null,
    dump_station_interval_days: v.dump_station_interval_days ?? null,
  };
}

function projectLeg(leg: LegWithDetails): PennyLeg {
  return {
    id: leg.id,
    sort_order: leg.sort_order,
    leg_type: leg.leg_type ?? 'drive',
    title: leg.title,
    label: leg.label,
    start_name: leg.start_name,
    end_name: leg.end_name,
    start_lat: leg.start_lat,
    start_lng: leg.start_lng,
    end_lat: leg.end_lat,
    end_lng: leg.end_lng,
    dates: leg.dates,
    distance_km: leg.distance_km,
    drive_time_minutes: leg.drive_time_minutes,
    terrain: leg.terrain,
    status: leg.status,
    notes: leg.parsedNotes,
    routes: leg.routes.map((r) => ({
      id: r.id,
      label: r.label,
      status: r.status,
      distance_km: r.distance_km,
      surface: r.surface,
      description: r.description,
      end_name: r.end_name,
      end_lat: r.end_lat,
      end_lng: r.end_lng,
    })),
    stops: leg.stops.map((s) => ({
      id: s.id,
      stop_type: s.stop_type,
      status: s.status,
      name: s.name,
      lat: s.lat,
      lng: s.lng,
      distance_from_start_km: s.distance_from_start_km,
      fuel_type: s.fuel_type,
      fuel_amount_l: s.fuel_amount_l,
      source: s.source,
      notes: s.notes,
    })),
    tasks: leg.tasks.map((t) => ({
      id: t.id,
      title: t.title,
      description: t.description,
      priority: t.priority,
      status: t.status,
      reference_url: t.reference_url,
    })),
  };
}

function projectChat(m: ChatMessage): { role: 'user' | 'assistant'; content: string } {
  return {
    role: m.role,
    content: m.content.slice(0, 4000),
  };
}
