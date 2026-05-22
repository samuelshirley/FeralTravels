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

// ── Travel style ────────────────────────────────────────────────────────────

export type TravelStyle = 'scenic_cruiser' | 'road_tripper' | 'get_me_there';

export const TRAVEL_STYLE_OPTIONS: Array<{
  value: TravelStyle;
  label: string;
  description: string;
}> = [
  {
    value: 'scenic_cruiser',
    label: 'Scenic cruiser',
    description: 'Short driving days (~4h), lots of stops — the drive IS the trip.',
  },
  {
    value: 'road_tripper',
    label: 'Road tripper',
    description: 'Moderate days (~6h) with a good balance of driving and exploring.',
  },
  {
    value: 'get_me_there',
    label: 'Get me there',
    description: 'Long driving days (~8h cruise, up to 12h transit) — you just want to arrive.',
  },
];

/**
 * Derive cruise + transit hour caps from a travel style. Also populates
 * the legacy `max_drive_hours_per_day` (= transit cap) for backward compat.
 */
export function deriveFromTravelStyle(style: TravelStyle): {
  cruise_max_drive_hours: number;
  transit_max_drive_hours: number;
  /** @deprecated Legacy field, equals transit cap. */
  max_drive_hours_per_day: number;
} {
  switch (style) {
    case 'scenic_cruiser':
      return { cruise_max_drive_hours: 4, transit_max_drive_hours: 8, max_drive_hours_per_day: 8 };
    case 'road_tripper':
      return { cruise_max_drive_hours: 6, transit_max_drive_hours: 10, max_drive_hours_per_day: 10 };
    case 'get_me_there':
      return { cruise_max_drive_hours: 8, transit_max_drive_hours: 12, max_drive_hours_per_day: 12 };
  }
}

/** Stored km between planned fuel stops — enforced on all vehicle saves. */
export const FUEL_STOP_SPACING_KM_MIN = 200;
export const FUEL_STOP_SPACING_KM_MAX = 1500;

/** Max consecutive driving days before a rest day (stored integer). */
export const MAX_CONSECUTIVE_DRIVE_DAYS_CAP = 7;

/** @deprecated Use {@link FUEL_STOP_SPACING_KM_MAX} */
export const REFILL_DISTANCE_KM_MAX = FUEL_STOP_SPACING_KM_MAX;

/**
 * Vehicles attached to trips or used for fuel planning must have refuel spacing
 * within product bounds. Shared by onboarding gating and API validation.
 */
export function vehicleMeetsFuelPlanningMinimum(vehicle: Record<string, unknown>): boolean {
  const r = vehicle.refill_distance_km;
  return (
    typeof r === 'number' &&
    Number.isInteger(r) &&
    r >= FUEL_STOP_SPACING_KM_MIN &&
    r <= FUEL_STOP_SPACING_KM_MAX
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

  // New path: travel_style drives everything
  const ts = vehicle.travel_style;
  const hasStyle = typeof ts === 'string' && ['scenic_cruiser', 'road_tripper', 'get_me_there'].includes(ts);

  // Legacy path: accept old fields too (pre-migration vehicles)
  const d = vehicle.max_drive_hours_per_day;
  const w = vehicle.max_drive_hours_per_week;
  const hasLegacy = typeof d === 'number' && d > 0 && typeof w === 'number' && w > 0;

  const c = vehicle.max_consecutive_drive_days;
  const hasConsec = typeof c === 'number' && Number.isInteger(c) && c > 0;

  return (hasStyle || hasLegacy) && hasConsec;
}

/** Plan / docs name — same as {@link vehicleMeetsCompletenessTier}. */
export const isVehicleCompleteForTier = vehicleMeetsCompletenessTier;

/** Dump station interval integers when tracking is enabled (matches question max default). */
export function dumpStationCadenceIntegerValid(n: unknown, max = 60): boolean {
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= max;
}

/**
 * Weekly drive budget derived from daily limit × longest consecutive-drive streak
 * (no separate "hours per week" prompt). Capped at 168.
 */
export function deriveMaxDriveHoursPerWeek(
  hoursPerDay: number,
  consecutiveDriveDays: number
): number {
  const raw = hoursPerDay * consecutiveDriveDays;
  const capped = Math.min(168, raw);
  return Math.round(capped * 10) / 10;
}

/**
 * Full profile completeness for remediation nag + PATCH validation — strict driving,
 * caravan gate persisted, dump station cadence iff dump_station_tracking_enabled is true.
 */
export function vehicleIsCompleteForRemediation(vehicle: Record<string, unknown>): boolean {
  if (!vehicleMeetsCompletenessTier(vehicle, 'strict_driving')) return false;
  const wt = vehicle.dump_station_tracking_enabled;
  if (wt !== true && wt !== false) return false;
  if (wt === false) return true;
  return dumpStationCadenceIntegerValid(vehicle.dump_station_interval_days);
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
    case 'travel_style':
      return typeof raw !== 'string' || !['scenic_cruiser', 'road_tripper', 'get_me_there'].includes(raw);
    case 'max_consecutive_drive_days':
    case 'rest_days_after_driving': {
      if (q.optional && (raw === null || raw === undefined)) return false;
      if (typeof raw !== 'number' || !Number.isFinite(raw)) return true;
      if (!Number.isInteger(raw)) return true;
      if (raw <= 0) return true;
      if (q.min !== undefined && raw < q.min) return true;
      if (q.max !== undefined && raw > q.max) return true;
      return false;
    }
    case 'dump_station_interval_days':
      return !dumpStationCadenceIntegerValid(raw);
  }
}
export const VEHICLE_PROFILE_KEYS = [
  'name',
  'refill_distance_km',
  'travel_style',
  'max_consecutive_drive_days',
  'rest_days_after_driving',
  'dump_station_interval_days',
] as const;

export type VehicleProfileFieldKey = (typeof VEHICLE_PROFILE_KEYS)[number];

export type VehicleProfileQuestionKind = 'text' | 'number' | 'integer' | 'select';

export type VehicleProfileFieldGroup = 'identity' | 'driving' | 'dump_station';

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
  /** For `kind: 'select'` — the available options. */
  options?: Array<{ value: string; label: string; description?: string }>;
}

/**
 * Unit-aware onboarding/settings prompts. Order is stable across unit prefs.
 */
export function buildVehicleProfileQuestions(units: UnitsPref): VehicleProfileQuestion[] {
  const isImperial = units === 'imperial';
  const distLabel = isImperial ? 'miles' : 'kilometers';
  const distMin = isImperial
    ? Math.round(kmToMi(FUEL_STOP_SPACING_KM_MIN)!)
    : FUEL_STOP_SPACING_KM_MIN;
  const distMax = isImperial
    ? Math.round(kmToMi(FUEL_STOP_SPACING_KM_MAX)!)
    : FUEL_STOP_SPACING_KM_MAX;
  const distPlaceholder = isImperial ? '250' : '400';

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
      key: 'travel_style',
      kind: 'select',
      group: 'driving',
      label: "What's your travel style?",
      help:
        'This sets how long your driving days are. Scenic cruisers stop often and keep drives short; ' +
        '"get me there" travelers are happy to grind a long transit day to maximize time at destinations.',
      options: TRAVEL_STYLE_OPTIONS,
    },
    {
      key: 'max_consecutive_drive_days',
      kind: 'integer',
      group: 'driving',
      label: 'Max consecutive driving days before a rest day?',
      placeholder: '3',
      min: 1,
      max: MAX_CONSECUTIVE_DRIVE_DAYS_CAP,
    },
    {
      key: 'rest_days_after_driving',
      kind: 'integer',
      group: 'driving',
      label: 'How many rest (non-driving) days do you need after a driving streak?',
      placeholder: '1',
      help: 'After your max consecutive driving days, how many days do you want to rest before driving again?',
      min: 1,
      max: 7,
      optional: true,
    },
    {
      key: 'dump_station_interval_days',
      kind: 'integer',
      group: 'dump_station',
      label: 'How many days between dump station visits?',
      placeholder: '4',
      min: 1,
      max: 30,
    },
  ];
}

export const VEHICLE_PROFILE_QUESTION_COUNT = VEHICLE_PROFILE_KEYS.length;

/** Caravan / RV gate — inserted in onboarding before dump station questions. */
export const CARAVAN_DUMP_STATION_GATE_KEY = 'caravan_dump_station_tracking';

export function caravanDumpStationGateLabel(): string {
  return 'Is this a caravan, camper, or motorhome where you want to track dump station visits?';
}

const STATIC_UNIT_SUFFIX: Partial<Record<VehicleProfileFieldKey, string>> = {
  dump_station_interval_days: ' days',
  max_consecutive_drive_days: ' days',
  rest_days_after_driving: ' rest days',
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
    case 'select': {
      if (typeof raw !== 'string') throw new Error(`Expected string for ${q.key}`);
      const valid = (q.options ?? []).map((o) => o.value);
      if (!valid.includes(raw)) throw new Error(`${q.key} must be one of: ${valid.join(', ')}`);
      return raw;
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
  if (q.kind === 'select' && q.options) {
    const opt = q.options.find((o) => o.value === value);
    return opt?.label ?? String(value);
  }
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
  if (q.kind === 'select' && q.options) {
    const opt = q.options.find((o) => o.value === value);
    return opt?.label ?? String(value);
  }
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

/**
 * Profile completion counts — dump station rows apply only when `dump_station_tracking_enabled === true`.
 */
export function vehicleProfileRequiredCompletion(vehicle: Record<string, unknown>): {
  filled: number;
  total: number;
} {
  const questions = buildVehicleProfileQuestions('metric');
  const wt = vehicle.dump_station_tracking_enabled;
  const applicable = questions.filter((q) => {
    if (q.group === 'dump_station') return wt === true;
    return true;
  });
  const filled = applicable.filter((q) => vehicleProfileFieldHasValue(vehicle, q)).length;
  return { filled, total: applicable.length };
}

/**
 * Whether a profile answer may be omitted (null). Used by onboarding/remediation POST guards.
 */
export function vehicleProfileQuestionAllowsNull(
  q: VehicleProfileQuestion,
  vehicle: Record<string, unknown>
): boolean {
  if (q.optional === true) return true;
  if (q.group === 'dump_station' && vehicle.dump_station_tracking_enabled !== true) return true;
  return false;
}

const GROUP_TITLES: Record<VehicleProfileFieldGroup, string> = {
  identity: 'Identity',
  driving: 'Driving limits',
  dump_station: 'Dump station',
};

export function vehicleProfileGroupTitle(group: VehicleProfileFieldGroup): string {
  return GROUP_TITLES[group];
}

export interface VehicleProfileDraftInput {
  name: string;
  refill_distance_km: number | null;
  travel_style: TravelStyle | null;
  max_consecutive_drive_days: number | null;
  rest_days_after_driving: number | null;
  dump_station_interval_days: number | null;
  /** Required for Settings saves; caravan gate persisted on vehicles. */
  dump_station_tracking_enabled?: boolean | null;
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
  const wt = draft.dump_station_tracking_enabled;

  if (wt !== true && wt !== false) {
    return { ok: false, error: 'Choose whether to track dump station visits.' };
  }

  payload.dump_station_tracking_enabled = wt;
  if (wt === false) {
    payload.dump_station_interval_days = null;
  }

  for (const q of questions) {
    try {
      if (q.group === 'dump_station' && wt === false) continue;

      const qCoerce =
        q.group === 'dump_station' && wt === true ? ({ ...q, optional: false } as VehicleProfileQuestion) : q;

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
        else raw = v as number | string | null;
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

  // Derive hour caps + legacy fields from travel_style
  const ts = payload.travel_style;
  if (typeof ts === 'string' && ['scenic_cruiser', 'road_tripper', 'get_me_there'].includes(ts)) {
    const derived = deriveFromTravelStyle(ts as TravelStyle);
    payload.cruise_max_drive_hours = derived.cruise_max_drive_hours;
    payload.transit_max_drive_hours = derived.transit_max_drive_hours;
    payload.max_drive_hours_per_day = derived.max_drive_hours_per_day;

    const consec = payload.max_consecutive_drive_days;
    if (typeof consec === 'number' && Number.isInteger(consec) && consec > 0) {
      payload.max_drive_hours_per_week = deriveMaxDriveHoursPerWeek(
        derived.max_drive_hours_per_day,
        consec
      );
    }
  }

  if (draft.is_default !== undefined) {
    payload.is_default = draft.is_default;
  }

  return { ok: true, payload };
}
