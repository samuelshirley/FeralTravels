/**
 * Canonical vehicle profile schema — shared by onboarding chat, Settings
 * vehicle form, and admin dashboards. Keys match `VehicleInput` / API
 * snake_case and the `vehicles` table.
 *
 * `is_default` is Settings-only (never collected in onboarding); keep it out
 * of this question list.
 */
import type { UnitsPref } from '@/lib/units';
import { kmToMi, miToKm } from '@/lib/units';

/** Matches vehicles API / fuel planner upper bound. */
export const REFILL_DISTANCE_KM_MAX = 5000;

/**
 * Vehicles attached to trips or used for fuel planning must have a positive
 * refill distance in km. Shared by onboarding gating and API validation.
 */
export function vehicleMeetsFuelPlanningMinimum(vehicle: Record<string, unknown>): boolean {
  const r = vehicle.refill_distance_km;
  return (
    typeof r === 'number' &&
    Number.isInteger(r) &&
    r > 0 &&
    r <= REFILL_DISTANCE_KM_MAX
  );
}

/** Tier A = fuel-plannable refill only; Tier B = also requires driving-limit block (stretch planning). */
export type VehicleCompletenessTier = 'fuel_plannable' | 'strict_driving';

export function vehicleMeetsCompletenessTier(
  vehicle: Record<string, unknown>,
  tier: VehicleCompletenessTier
): boolean {
  if (!vehicleMeetsFuelPlanningMinimum(vehicle)) return false;
  if (tier === 'fuel_plannable') return true;
  const d = vehicle.max_drive_hours_per_day;
  const w = vehicle.max_drive_hours_per_week;
  const c = vehicle.max_consecutive_drive_days;
  return (
    typeof d === 'number' &&
    d > 0 &&
    typeof w === 'number' &&
    w > 0 &&
    typeof c === 'number' &&
    Number.isInteger(c) &&
    c > 0
  );
}

/** Plan / docs name — same as {@link vehicleMeetsCompletenessTier}. */
export const isVehicleCompleteForTier = vehicleMeetsCompletenessTier;

/** Water cadence integers when tracking is enabled (matches question max default). */
export function vehicleWaterCadenceIntegerValid(n: unknown, max = 60): boolean {
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= max;
}

/**
 * Full profile completeness for remediation nag + PATCH validation — strict driving,
 * caravan gate persisted, water cadence iff water_tracking_enabled is true.
 */
export function vehicleIsCompleteForRemediation(vehicle: Record<string, unknown>): boolean {
  if (!vehicleMeetsCompletenessTier(vehicle, 'strict_driving')) return false;
  const wt = vehicle.water_tracking_enabled;
  if (wt !== true && wt !== false) return false;
  if (wt === false) return true;
  return (
    vehicleWaterCadenceIntegerValid(vehicle.water_refill_days) &&
    vehicleWaterCadenceIntegerValid(vehicle.blackwater_refill_days)
  );
}

/**
 * True when onboarding/remediation must (re-)ask about this field: empty in DB **or**
 * present but failing the same rules as {@link vehicleIsCompleteForRemediation} for that slice.
 *
 * Important: remediation used to treat any non-null cell as “filled”, so corrupt values such as
 * `refill_distance_km: 0` or zeros on driving limits stranded users with `needs_remediation` set
 * but no snapshot question (`VehicleRemediationOverlay` never appeared).
 */
export function storedVehicleProfileFieldNeedsRemediationRepair(
  q: VehicleProfileQuestion,
  raw: unknown
): boolean {
  const missing = raw === null || raw === undefined || raw === '';
  if (missing) return true;

  switch (q.key) {
    case 'name':
      return typeof raw !== 'string' || raw.trim().length === 0;
    case 'refill_distance_km':
      return !vehicleMeetsFuelPlanningMinimum({ refill_distance_km: raw });
    case 'max_drive_hours_per_day':
    case 'max_drive_hours_per_week': {
      if (typeof raw !== 'number' || !Number.isFinite(raw)) return true;
      if (raw <= 0) return true;
      if (q.min !== undefined && raw < q.min) return true;
      if (q.max !== undefined && raw > q.max) return true;
      return false;
    }
    case 'max_consecutive_drive_days': {
      if (typeof raw !== 'number' || !Number.isFinite(raw)) return true;
      if (!Number.isInteger(raw)) return true;
      if (raw <= 0) return true;
      if (q.min !== undefined && raw < q.min) return true;
      if (q.max !== undefined && raw > q.max) return true;
      return false;
    }
    case 'water_refill_days':
    case 'blackwater_refill_days':
      return !vehicleWaterCadenceIntegerValid(raw);
  }
}
export const VEHICLE_PROFILE_KEYS = [
  'name',
  'refill_distance_km',
  'max_drive_hours_per_day',
  'max_drive_hours_per_week',
  'max_consecutive_drive_days',
  'water_refill_days',
  'blackwater_refill_days',
] as const;

export type VehicleProfileFieldKey = (typeof VEHICLE_PROFILE_KEYS)[number];

export type VehicleProfileQuestionKind = 'text' | 'number' | 'integer';

export type VehicleProfileFieldGroup = 'identity' | 'driving' | 'water';

export interface VehicleProfileQuestion {
  key: VehicleProfileFieldKey;
  kind: VehicleProfileQuestionKind;
  label: string;
  placeholder?: string;
  help?: string;
  optional?: boolean;
  min?: number;
  max?: number;
  group: VehicleProfileFieldGroup;
}

/**
 * Unit-aware onboarding/settings prompts. Order is stable across unit prefs.
 */
export function buildVehicleProfileQuestions(units: UnitsPref): VehicleProfileQuestion[] {
  const isImperial = units === 'imperial';
  const distLabel = isImperial ? 'miles' : 'kilometers';
  const distPlaceholder = isImperial ? '250' : '400';
  const distMin = isImperial ? 30 : 50;
  const distMax = isImperial ? 1500 : 2500;

  return [
    {
      key: 'name',
      kind: 'text',
      group: 'identity',
      label: "What's the vehicle called? (just a nickname is fine)",
      placeholder: 'e.g. Duncan',
    },
    {
      key: 'refill_distance_km',
      kind: 'integer',
      group: 'driving',
      label: `How far between fuel stops, in ${distLabel}?`,
      placeholder: distPlaceholder,
      help:
        'Tell me roughly how far you like to drive on a tank before refueling. ' +
        "I'll plan a fuel stop every ~that distance, regardless of your tank's actual capacity.",
      min: distMin,
      max: distMax,
    },
    {
      key: 'max_drive_hours_per_day',
      kind: 'number',
      group: 'driving',
      label: 'Max hours you want to drive per day?',
      placeholder: '6',
      min: 1,
      max: 24,
    },
    {
      key: 'max_drive_hours_per_week',
      kind: 'number',
      group: 'driving',
      label: 'Max hours per week?',
      placeholder: '30',
      min: 1,
      max: 100,
    },
    {
      key: 'max_consecutive_drive_days',
      kind: 'integer',
      group: 'driving',
      label: 'Max consecutive driving days before a rest day?',
      placeholder: '3',
      min: 1,
      max: 14,
    },
    {
      key: 'water_refill_days',
      kind: 'integer',
      group: 'water',
      label: 'How many days between freshwater refills?',
      placeholder: '4',
      min: 1,
      max: 30,
      optional: true,
    },
    {
      key: 'blackwater_refill_days',
      kind: 'integer',
      group: 'water',
      label: 'How many days between black/grey water dumps?',
      placeholder: '5',
      min: 1,
      max: 30,
      optional: true,
    },
  ];
}

export const VEHICLE_PROFILE_QUESTION_COUNT = VEHICLE_PROFILE_KEYS.length;

/** Caravan / RV gate — inserted in onboarding before water questions. */
export const CARAVAN_WATER_GATE_KEY = 'caravan_water_tracking';

export function caravanWaterGateLabel(): string {
  return 'Is this a caravan, camper, or motorhome where you want to track freshwater refill and grey/black water dump timing?';
}

const STATIC_UNIT_SUFFIX: Partial<Record<VehicleProfileFieldKey, string>> = {
  water_refill_days: ' days',
  blackwater_refill_days: ' days',
  max_drive_hours_per_day: ' h/day',
  max_drive_hours_per_week: ' h/week',
  max_consecutive_drive_days: ' days',
};

/**
 * Validate and parse one answer in the same units the user sees (miles for
 * imperial refill_distance_km; all other fields are unit-agnostic).
 */
export function coerceVehicleProfileValue(
  q: VehicleProfileQuestion,
  raw: unknown
): unknown {
  if (q.optional && (raw === null || raw === undefined || raw === '')) return null;

  switch (q.kind) {
    case 'text': {
      if (typeof raw !== 'string') throw new Error(`Expected string for ${q.key}`);
      const s = raw.trim();
      if (!q.optional && !s) throw new Error(`${q.key} is required`);
      return s;
    }
    case 'number':
    case 'integer': {
      if (!q.optional && (raw === null || raw === undefined || raw === '')) {
        throw new Error(`${q.key} is required`);
      }
      const n = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isFinite(n)) throw new Error(`Expected number for ${q.key}`);
      if (q.kind === 'integer' && !Number.isInteger(n)) {
        throw new Error(`Expected integer for ${q.key}`);
      }
      if (q.min !== undefined && n < q.min) {
        throw new Error(`${q.key} must be ≥ ${q.min}`);
      }
      if (q.max !== undefined && n > q.max) {
        throw new Error(`${q.key} must be ≤ ${q.max}`);
      }
      return n;
    }
    default: {
      const _exhaustive: never = q.kind;
      throw new Error(`Unhandled question kind ${(_exhaustive as string) ?? ''}`);
    }
  }
}

/** Chat bubble / optimistic UI — onboarding uses this wording */
export function humanizeVehicleProfileAnswer(
  q: VehicleProfileQuestion,
  value: unknown,
  units: UnitsPref
): string {
  if (value === null || value === undefined || value === '') return '(skipped)';
  if (q.key === 'refill_distance_km') {
    return `${value}${units === 'imperial' ? ' mi' : ' km'}`;
  }
  return `${value}${STATIC_UNIT_SUFFIX[q.key] ?? ''}`;
}

/** Admin checklist — neutral empty marker */
export function formatVehicleProfileFieldDisplay(
  q: VehicleProfileQuestion,
  value: unknown,
  units: UnitsPref
): string {
  if (value === null || value === undefined || value === '') return '—';
  if (q.key === 'refill_distance_km') {
    return `${value} ${units === 'imperial' ? 'mi' : 'km'}`;
  }
  return `${value}${STATIC_UNIT_SUFFIX[q.key] ?? ''}`;
}

export function vehicleProfileFieldHasValue(
  vehicle: Record<string, unknown>,
  q: VehicleProfileQuestion
): boolean {
  const raw = vehicle[q.key];
  return raw !== null && raw !== undefined && raw !== '';
}

/** Required = not optional in schema */
export function vehicleProfileRequiredCompletion(vehicle: Record<string, unknown>): {
  filled: number;
  total: number;
} {
  const questions = buildVehicleProfileQuestions('metric');
  const required = questions.filter((q) => !q.optional);
  const filled = required.filter((q) => vehicleProfileFieldHasValue(vehicle, q)).length;
  return { filled, total: required.length };
}

const GROUP_TITLES: Record<VehicleProfileFieldGroup, string> = {
  identity: 'Identity',
  driving: 'Driving limits',
  water: 'Water',
};

export function vehicleProfileGroupTitle(group: VehicleProfileFieldGroup): string {
  return GROUP_TITLES[group];
}

export interface VehicleProfileDraftInput {
  name: string;
  refill_distance_km: number | null;
  max_drive_hours_per_day: number | null;
  max_drive_hours_per_week: number | null;
  max_consecutive_drive_days: number | null;
  water_refill_days: number | null;
  blackwater_refill_days: number | null;
  /** Required for Settings saves; caravan gate persisted on vehicles. */
  water_tracking_enabled?: boolean | null;
  is_default?: boolean;
}

/**
 * Validate draft using the same rules as onboarding; returns API-ready body
 * (snake_case vehicle fields + optional `is_default`).
 */
export function validateVehicleProfileDraftForSave(
  draft: VehicleProfileDraftInput,
  units: UnitsPref
): { ok: true; payload: Record<string, unknown> } | { ok: false; error: string } {
  const questions = buildVehicleProfileQuestions(units);
  const payload: Record<string, unknown> = {};
  const wt = draft.water_tracking_enabled;

  if (wt !== true && wt !== false) {
    return { ok: false, error: 'Choose whether to track freshwater and dump timing.' };
  }

  payload.water_tracking_enabled = wt;
  if (wt === false) {
    payload.water_refill_days = null;
    payload.blackwater_refill_days = null;
  }

  for (const q of questions) {
    try {
      if (q.group === 'water' && wt === false) continue;

      const qCoerce =
        q.group === 'water' && wt === true ? ({ ...q, optional: false } as VehicleProfileQuestion) : q;

      let raw: unknown;
      if (q.key === 'name') {
        raw = draft.name;
      } else if (q.key === 'refill_distance_km') {
        if (draft.refill_distance_km == null) raw = null;
        else if (units === 'imperial') {
          const mi = kmToMi(draft.refill_distance_km);
          raw = mi == null ? null : Math.round(mi);
        } else raw = draft.refill_distance_km;
      } else {
        const v = draft[q.key as keyof VehicleProfileDraftInput];
        if (v === null || v === undefined) raw = null;
        else if (typeof v === 'string' && v === '') raw = null;
        else raw = v as number | null;
      }

      const parsed = coerceVehicleProfileValue(qCoerce, raw);

      if (q.key === 'name') {
        payload.name = parsed;
        continue;
      }

      if (q.key === 'refill_distance_km' && units === 'imperial') {
        const km = parsed == null ? null : miToKm(parsed as number);
        payload.refill_distance_km = km == null ? null : Math.round(km);
      } else {
        payload[q.key] = parsed;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Invalid value.';
      return { ok: false, error: msg };
    }
  }

  if (draft.is_default !== undefined) {
    payload.is_default = draft.is_default;
  }

  return { ok: true, payload };
}
