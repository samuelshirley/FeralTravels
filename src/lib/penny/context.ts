import 'server-only';
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
    id: number;
    name: string;
    start_date: string | null;
    end_date: string | null;
    status: string;
  };
  vehicle: PennyVehicle | null;
  legs: PennyLeg[];
  recentChat: Array<{ role: 'user' | 'assistant'; content: string }>;
}

export interface PennyVehicle {
  id: number;
  name: string;
  vehicle_type: string | null;
  fuel_type: string | null;
  fuel_economy_kmpl: number | null;
  fuel_tank_l: number | null;
  /** Derived: economy × tank × 0.8 (flat 20% reserve). null if either input is missing. */
  effective_range_km: number | null;
  max_drive_hours_per_day: number | null;
  max_drive_hours_per_week: number | null;
  max_consecutive_drive_days: number | null;
  freshwater_capacity_l: number | null;
  blackwater_capacity_l: number | null;
  water_refill_days: number | null;
  blackwater_refill_days: number | null;
  height_m: number | null;
  length_m: number | null;
  weight_kg: number | null;
  notes: string | null;
}

export interface PennyLeg {
  id: number;
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
  status: string;
  notes: string[];
  routes: Array<{
    id: number;
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
    id: number;
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
    id: number;
    title: string;
    description: string | null;
    priority: string;
    status: string;
    reference_url: string | null;
  }>;
}

/**
 * Flat 20% reserve buffer, the rule overlanders actually teach: always plan to
 * arrive with at least a fifth of a tank in hand. Replaces the old
 * `fuel_reserve_km` column which asked users for a km number most don't know.
 */
export const FUEL_BUFFER_FRACTION = 0.2;

/** Pulled out so the UI and Penny share one definition. */
export function computeEffectiveRangeKm(
  kmpl: number | null,
  tankL: number | null
): number | null {
  if (!kmpl || !tankL) return null;
  return Math.max(0, Math.round(kmpl * tankL * (1 - FUEL_BUFFER_FRACTION)));
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
  tripId: number,
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
    vehicle_type: v.vehicle_type,
    fuel_type: v.fuel_type,
    fuel_economy_kmpl: v.fuel_economy_kmpl,
    fuel_tank_l: v.fuel_tank_l,
    effective_range_km: computeEffectiveRangeKm(v.fuel_economy_kmpl, v.fuel_tank_l),
    max_drive_hours_per_day: v.max_drive_hours_per_day,
    max_drive_hours_per_week: v.max_drive_hours_per_week,
    max_consecutive_drive_days: v.max_consecutive_drive_days,
    freshwater_capacity_l: v.freshwater_capacity_l,
    blackwater_capacity_l: v.blackwater_capacity_l,
    water_refill_days: v.water_refill_days,
    blackwater_refill_days: v.blackwater_refill_days,
    height_m: v.height_cm != null ? Number((v.height_cm / 100).toFixed(2)) : null,
    length_m: v.length_m,
    weight_kg: v.weight_kg,
    notes: v.notes,
  };
}

function projectLeg(leg: LegWithDetails): PennyLeg {
  return {
    id: leg.id,
    sort_order: leg.sort_order,
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
