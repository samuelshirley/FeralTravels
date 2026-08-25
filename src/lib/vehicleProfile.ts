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

/** Stored km between planned fuel stops — enforced on all vehicle saves. */
export const FUEL_STOP_SPACING_KM_MIN = 200;
export const FUEL_STOP_SPACING_KM_MAX = 1500;

/**
 * Default cap on a single driving day's drive time (hours). MVP no longer asks
 * for a travel style, so the day-by-day planner and leg validators fall back to
 * this whenever a vehicle has no stored per-day cap (the common case now). See
 * the `addLeg`/`updateLeg` validators and `get_route` splitting in `claude.ts`.
 */
export const DEFAULT_MAX_DRIVE_HOURS_PER_DAY = 8;

/**
 * Guard a stored range for planning use: null unless a positive number; rounded.
 * (If range-shaping logic ever exists — terrain modifiers, towing derate — it
 * goes here in one place.)
 */
export function normalizeRangeKm(rangeKm: number | null): number | null {
  if (rangeKm == null || rangeKm <= 0) return null;
  return Math.round(rangeKm);
}

/**
 * Vehicles attached to trips or used for fuel planning must have refuel spacing
 * within product bounds. Shared by onboarding gating and API validation.
 */
export function vehicleMeetsFuelPlanningMinimum(vehicle: Record<string, unknown>): boolean {
  const r = vehicle.range_km;
  return (
    typeof r === 'number' &&
    Number.isInteger(r) &&
    r >= FUEL_STOP_SPACING_KM_MIN &&
    r <= FUEL_STOP_SPACING_KM_MAX
  );
}

/**
 * Validate an estimated fuel range (km): a whole number inside the
 * product band. Pure — shared by the onboarding range-help estimator
 * (`parseRangeEstimate.ts`) so a hallucinated/out-of-band value can't be
 * proposed. Returns the number or null.
 */
export function validateRangeKm(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || !Number.isInteger(raw)) {
    return null;
  }
  if (raw < FUEL_STOP_SPACING_KM_MIN || raw > FUEL_STOP_SPACING_KM_MAX) return null;
  return raw;
}

export const VEHICLE_PROFILE_KEYS = [
  'name',
  'range_km',
] as const;

export type VehicleProfileFieldKey = (typeof VEHICLE_PROFILE_KEYS)[number];

export type VehicleProfileQuestionKind = 'text' | 'number' | 'integer' | 'select';

export type VehicleProfileFieldGroup = 'identity' | 'driving';

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
      key: 'range_km',
      kind: 'integer',
      group: 'driving',
      label: `What's your driving range on a tank, in ${distLabel}?`,
      placeholder: distPlaceholder,
      help:
        'How far you’re happy to drive before you’d want to refuel — not the absolute ' +
        'max your vehicle can do, the distance where you’d naturally start looking for fuel. ' +
        'Whatever cushion you keep in your head is already baked in. ' +
        '(Not sure? I can help you work it out.)',
      min: distMin,
      max: distMax,
    },
  ];
}

export const VEHICLE_PROFILE_QUESTION_COUNT = VEHICLE_PROFILE_KEYS.length;

const STATIC_UNIT_SUFFIX: Partial<Record<VehicleProfileFieldKey, string>> = {};

/**
 * Validate and parse one answer in the same units the user sees (miles for
 * imperial range_km; all other fields are unit-agnostic).
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
  if (q.key === 'range_km') {
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
  if (q.key === 'range_km') {
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

/** Profile completion counts. */
export function vehicleProfileRequiredCompletion(vehicle: Record<string, unknown>): {
  filled: number;
  total: number;
} {
  const questions = buildVehicleProfileQuestions('metric');
  const filled = questions.filter((q) => vehicleProfileFieldHasValue(vehicle, q)).length;
  return { filled, total: questions.length };
}

/**
 * Whether a profile answer may be omitted (null). Used by onboarding POST guards.
 */
export function vehicleProfileQuestionAllowsNull(
  q: VehicleProfileQuestion,
  _vehicle: Record<string, unknown>
): boolean {
  return q.optional === true;
}

const GROUP_TITLES: Record<VehicleProfileFieldGroup, string> = {
  identity: 'Identity',
  driving: 'Driving limits',
};

export function vehicleProfileGroupTitle(group: VehicleProfileFieldGroup): string {
  return GROUP_TITLES[group];
}

export interface VehicleProfileDraftInput {
  name: string;
  range_km: number | null;
  is_default?: boolean;
}

/**
 * Validate draft using the same rules as onboarding; returns API-ready body
 * (snake_case vehicle fields + optional `is_default`). MVP profile is just the
 * vehicle name + fuel range.
 */
export function validateVehicleProfileDraftForSave(
  draft: VehicleProfileDraftInput,
  units: UnitsPref
): { ok: true; payload: Record<string, unknown> } | { ok: false; error: string } {
  const questions = buildVehicleProfileQuestions(units);
  const payload: Record<string, unknown> = {};

  for (const q of questions) {
    try {
      let raw: unknown;
      if (q.key === 'name') {
        raw = draft.name;
      } else {
        // range_km — unit-aware coercion.
        const v = draft[q.key];
        if (v == null) raw = null;
        else if (units === 'imperial') {
          const mi = kmToMi(v);
          raw = mi == null ? null : Math.round(mi);
        } else raw = v;
      }

      const parsed = coerceVehicleProfileValue(q, raw);

      if (q.key === 'name') {
        payload.name = parsed;
        continue;
      }

      if (units === 'imperial') {
        const km = parsed == null ? null : miToKm(parsed as number);
        payload[q.key] = km == null ? null : Math.round(km);
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
