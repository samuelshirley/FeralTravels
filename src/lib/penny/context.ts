import 'server-only';
import { vehicleMeetsFuelPlanningMinimum } from '@/lib/vehicleProfile';
import { getTripFull } from '@/server/repos/trips';
import { getChatPage } from '@/server/repos/chat';
import {
  getDefaultVehicleForUser,
  getVehicleForUser,
  type VehicleApi,
} from '@/server/repos/vehicles';
import { getUnitsPref } from '@/server/repos/users';
import { todayISO } from '@/lib/dates';
import type { UnitsPref } from '@/lib/units';
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
    start_date_parsed: string;
    status: string;
    /**
     * Driver-reported progress. `current_leg_id` is the leg they're on / about
     * to drive next (set via report_position); legs before it are behind them.
     * Null when the driver hasn't reported progress yet.
     */
    current_leg_id: string | null;
    current_place: string | null;
  };
  /** Today's calendar date, ISO "YYYY-MM-DD" — use it to reason about progress. */
  today: string;
  vehicle: PennyVehicle | null;
  legs: PennyLeg[];
  recentChat: Array<{ role: 'user' | 'assistant'; content: string }>;
  /**
   * True when the driver's saved vehicle row fails strict profile completeness
   * (fuel + driving caps + caravan dump station gate). Penny must steer to Settings
   * or `/vehicle-setup` instead of implying automated fuel/routing succeeded.
   */
  vehicle_profile_blocked: boolean;
  /** User's preferred distance units — 'metric' or 'imperial'. */
  units_pref: UnitsPref;
}

/**
 * Trimmed vehicle shape Penny plans against: user-stated refuel cadence +
 * drive limits + optional dump station cadence. `effective_range_km` aliases
 * `comfortable_range_km` for prompts and the fuel planner.
 */
export interface PennyVehicle {
  id: string;
  name: string;
  comfortable_range_km: number | null;
  /**
   * Hard ceiling between fills (km) handed to Finn — never route a dry stretch
   * past this, for any price. Defaults to comfortable_range_km when the driver
   * gave no separate max.
   */
  hard_max_range_km: number | null;
  /** Alias of comfortable_range_km — kept for prompt/system-side stability. */
  effective_range_km: number | null;
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
  /**
   * Server-computed calendar date (ISO "YYYY-MM-DD") this leg falls on, or
   * null when the trip start date isn't set. Penny reads this to reason about
   * fixed-date constraints — e.g. checking whether the leg departing a waypoint
   * actually lands on the date the user demanded.
   */
  date_iso: string | null;
  distance_km: number | null;
  drive_time_minutes: number | null;
  terrain: string | null;
  status: string;
  /**
   * Set when continuity repair couldn't re-route this leg (distance/time/geometry
   * were cleared). When present, the leg has no usable route — Penny should tell
   * the user and offer to fix the coordinates rather than reason over a phantom
   * distance. Null when the leg routes cleanly.
   */
  continuity_warning: string | null;
  notes: string[];
  /** Stop-to-stop jump tag for itinerary LEG grouping (see add_leg). */
  segment_index: number | null;
  segment_name: string | null;
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
 * computation into a single user-stated `comfortable_range_km` ("I like to refuel
 * every ~X km"). This helper exists so callers don't reach into the vehicle row
 * directly — if we ever add range-shaping logic (terrain modifiers, towing
 * derate, etc.) it goes here in one place. Today it's the identity function on
 * a non-positive guard.
 */
export function computeEffectiveRangeKm(
  comfortableRangeKm: number | null
): number | null {
  if (comfortableRangeKm == null || comfortableRangeKm <= 0) return null;
  return Math.round(comfortableRangeKm);
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

  const [vehicle, unitsPref] = await Promise.all([
    resolveVehicle(trip, userId),
    getUnitsPref(userId),
  ]);
  const chatPage = await getChatPage({
    tripId,
    limit: options.recentChatLimit ?? 12,
    // Only feed live chat back into Penny — onboarding form Q/A rows would
    // look like user instructions and confuse her.
    kinds: ['ai'],
  });

  // Penny's only hard requirement for fuel planning is a comfortable range in
  // the product band. (The old multi-field remediation gate is gone.)
  const vehicle_profile_blocked =
    vehicle == null ||
    !vehicleMeetsFuelPlanningMinimum({ comfortable_range_km: vehicle.comfortable_range_km });

  const currentLeg = trip.current_leg_id
    ? trip.legs.find((l) => l.id === trip.current_leg_id) ?? null
    : null;

  return {
    trip: {
      id: trip.id,
      name: trip.name,
      start_date: trip.start_date,
      end_date: trip.end_date,
      start_date_parsed: trip.start_date_parsed,
      status: trip.status,
      current_leg_id: trip.current_leg_id,
      current_place: currentLeg?.start_name ?? null,
    },
    today: todayISO(),
    vehicle: vehicle ? projectVehicle(vehicle) : null,
    legs: trip.legs.map(projectLeg),
    recentChat: chatPage.messages.map(projectChat),
    vehicle_profile_blocked,
    units_pref: unitsPref,
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
  const range = computeEffectiveRangeKm(v.comfortable_range_km);
  return {
    id: v.id,
    name: v.name,
    comfortable_range_km: v.comfortable_range_km,
    // Hard ceiling handed to Finn — never route a dry stretch past this. Falls
    // back to comfortable when unset (conservative; Finn simply never stretches).
    hard_max_range_km: v.hard_max_range_km ?? v.comfortable_range_km,
    effective_range_km: range,
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
    date_iso: leg.date_iso,
    distance_km: leg.distance_km,
    drive_time_minutes: leg.drive_time_minutes,
    terrain: leg.terrain,
    status: leg.status,
    continuity_warning: leg.continuity_warning ?? null,
    notes: leg.parsedNotes,
    segment_index: leg.segment_index,
    segment_name: leg.segment_name,
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
