import 'server-only';
import { normalizeRangeKm, vehicleMeetsFuelPlanningMinimum } from '@/lib/vehicleProfile';
import { getTripFull } from '@/server/repos/trips';
import { getChatPage } from '@/server/repos/chat';
import {
  getDefaultVehicleForUser,
  getVehicleForUser,
  type VehicleApi,
} from '@/server/repos/vehicles';
import { getUnitsPref, getUserTimezone } from '@/server/repos/users';
import { todayISOInZone } from '@/lib/dates';
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
    /**
     * The driver's declared tank state (the `declare_fuel_state` tool), or
     * null when none is active. `leg_id` anchors it: the driver said they can
     * cover `remaining_range_km` from that leg's START before needing fuel.
     * Superseded automatically once a fuel stop is passed. Read this before
     * re-asking about tank state or re-declaring the same numbers.
     */
    declared_fuel_state: {
      remaining_range_km: number;
      leg_id: string;
      as_of: string | null;
    } | null;
  };
  /** Today's calendar date, ISO "YYYY-MM-DD" — use it to reason about progress. */
  today: string;
  /**
   * The driver's DEVICE location — captured from the browser's GPS each time
   * they open the app (distinct from `trip.current_place`, which is the progress
   * anchor Penny herself sets via report_position). This is what "where I am" /
   * "my current location" refers to. Null when GPS was never granted / captured.
   * `place` is a best-effort reverse-geocoded label (may be null even when coords
   * exist); `as_of` is when it was captured so Penny can judge staleness.
   */
  device_location: {
    lat: number;
    lng: number;
    place: string | null;
    as_of: string | null;
  } | null;
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
 * Trimmed vehicle shape Penny plans against: the user-stated fuel range
 * (`range_km`) — the single range number the planner uses.
 */
export interface PennyVehicle {
  id: string;
  name: string;
  range_km: number | null;
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

  const [vehicle, unitsPref, timezone] = await Promise.all([
    resolveVehicle(trip, userId),
    getUnitsPref(userId),
    getUserTimezone(userId),
  ]);
  const chatPage = await getChatPage({
    tripId,
    limit: options.recentChatLimit ?? 12,
    // Only feed live chat back into Penny — onboarding form Q/A rows would
    // look like user instructions and confuse her.
    kinds: ['ai'],
  });

  // Penny's only hard requirement for fuel planning is a fuel range in
  // the product band. (The old multi-field remediation gate is gone.)
  const vehicle_profile_blocked =
    vehicle == null ||
    !vehicleMeetsFuelPlanningMinimum({ range_km: vehicle.range_km });

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
      declared_fuel_state:
        trip.declared_range_km != null &&
        trip.declared_range_leg_id != null &&
        // A stale anchor (leg deleted since) is ignored — same contract as
        // resolveDeclaredTankAnchor in server/fuel.ts.
        trip.legs.some((l) => l.id === trip.declared_range_leg_id)
          ? {
              remaining_range_km: trip.declared_range_km,
              leg_id: trip.declared_range_leg_id,
              as_of: trip.declared_range_at,
            }
          : null,
    },
    today: todayISOInZone(timezone),
    device_location:
      trip.last_known_lat != null && trip.last_known_lng != null
        ? {
            lat: trip.last_known_lat,
            lng: trip.last_known_lng,
            place: trip.last_known_place,
            as_of: trip.position_updated_at,
          }
        : null,
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
  return {
    id: v.id,
    name: v.name,
    range_km: normalizeRangeKm(v.range_km),
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
