import 'server-only';
import { HttpError } from '@/server/auth/guards';
import type { Question } from '@/server/onboarding';
import {
  buildVehicleProfileQuestions,
  caravanDumpStationGateLabel,
  CARAVAN_DUMP_STATION_GATE_KEY,
  coerceVehicleProfileValue,
  deriveFromTravelStyle,
  deriveMaxDriveHoursPerWeek,
  vehicleIsCompleteForRemediation,
  storedVehicleProfileFieldNeedsRemediationRepair,
  vehicleProfileQuestionAllowsNull,
  type TravelStyle,
  type VehicleProfileQuestion,
} from '@/lib/vehicleProfile';
import type { UnitsPref } from '@/lib/units';
import { miToKm } from '@/lib/units';
import {
  recalculateUserRemediationFlag,
} from '@/server/repos/remediationFlags';
import { getUnitsPref } from '@/server/repos/users';
import {
  getVehicleForUser,
  listVehiclesForUser,
  updateVehicle,
  type VehicleApi,
  type VehicleInput,
} from '@/server/repos/vehicles';

type ProfileStep = { t: 'profile'; q: VehicleProfileQuestion } | { t: 'gate' };

function buildRemediationSteps(units: UnitsPref): ProfileStep[] {
  const qs = buildVehicleProfileQuestions(units);
  const wi = qs.findIndex((q) => q.group === 'dump_station');
  if (wi < 0) return qs.map((q) => ({ t: 'profile' as const, q }));
  return [
    ...qs.slice(0, wi).map((q) => ({ t: 'profile' as const, q })),
    { t: 'gate' },
    ...qs.slice(wi).map((q) => ({ t: 'profile' as const, q })),
  ];
}

function dumpStationGateResolvedDb(vehicle: VehicleApi): boolean {
  const wt = vehicle.dump_station_tracking_enabled;
  return wt === true || wt === false;
}

function remediationProfileQuestionRequired(q: VehicleProfileQuestion, vehicle: VehicleApi): boolean {
  if (!q.optional) return true;
  return q.group === 'dump_station' && vehicle.dump_station_tracking_enabled === true;
}

function remediationProfileNeedsAsking(q: VehicleProfileQuestion, vehicle: VehicleApi): boolean {
  if (q.group === 'dump_station' && vehicle.dump_station_tracking_enabled === false) return false;
  const required = remediationProfileQuestionRequired(q, vehicle);
  if (!required) return false;
  const raw = (vehicle as unknown as Record<string, unknown>)[q.key];
  return storedVehicleProfileFieldNeedsRemediationRepair(q, raw);
}

function nextRemediationQuestionInner(
  vehicle: VehicleApi,
  unitsPref: UnitsPref
): { question: Question; progress: { current: number; total: number } } | null {
  const gateLabel = caravanDumpStationGateLabel();
  const steps = buildRemediationSteps(unitsPref);
  const total = steps.length;

  for (let s = 0; s < steps.length; s++) {
    const step = steps[s];
    if (step.t === 'gate') {
      if (!dumpStationGateResolvedDb(vehicle)) {
        return {
          question: {
            key: CARAVAN_DUMP_STATION_GATE_KEY,
            kind: 'select',
            label: gateLabel,
            help: 'If not, we will skip dump station timing questions.',
            options: [
              { value: 'yes', label: 'Yes, track dump station visits' },
              { value: 'no', label: 'No' },
            ],
          },
          progress: { current: s + 1, total },
        };
      }
      continue;
    }
    const q = step.q;
    if (remediationProfileNeedsAsking(q, vehicle)) {
      const question: Question = {
        ...(q as Question),
        optional: q.optional && !(q.group === 'dump_station' && vehicle.dump_station_tracking_enabled === true),
      };
      return {
        question,
        progress: { current: s + 1, total },
      };
    }
  }

  return null;
}

function orderedIncompleteVehicles(all: VehicleApi[]): VehicleApi[] {
  const bad = all.filter((v) => !vehicleIsCompleteForRemediation(v as Record<string, unknown>));
  return bad.sort((a, b) => a.id.localeCompare(b.id));
}

/** Persist weekly hours = daily × consecutive streak when both are set (legacy rows may be null/stale). */
async function maybeRepairDerivedWeeklyHours(userId: string, vehicle: VehicleApi): Promise<VehicleApi> {
  const day = vehicle.max_drive_hours_per_day;
  const consec = vehicle.max_consecutive_drive_days;
  if (typeof day !== 'number' || day <= 0 || typeof consec !== 'number' || consec <= 0) {
    return vehicle;
  }
  const target = deriveMaxDriveHoursPerWeek(day, consec);
  const w = vehicle.max_drive_hours_per_week;
  if (w == null || !Number.isFinite(w) || Math.abs(w - target) > 0.01) {
    await updateVehicle(userId, vehicle.id, { max_drive_hours_per_week: target });
    const fresh = await getVehicleForUser(userId, vehicle.id);
    if (fresh) return fresh;
    return { ...vehicle, max_drive_hours_per_week: target };
  }
  return vehicle;
}

export interface VehicleRemediationSnapshot {
  needs_remediation: boolean;
  done: boolean;
  active_vehicle: { id: string; name: string } | null;
  question: Question | null;
  progress: { current: number; total: number } | null;
  /** Account has zero vehicles — prompts via overlay to add one in Settings. */
  garage_empty?: boolean;
}

export async function getVehicleRemediationSnapshot(userId: string): Promise<VehicleRemediationSnapshot> {
  let list = await listVehiclesForUser(userId);

  if (list.length === 0) {
    await recalculateUserRemediationFlag(userId);
    return {
      needs_remediation: true,
      done: false,
      active_vehicle: null,
      question: null,
      progress: null,
      garage_empty: true,
    };
  }

  let incompletes = orderedIncompleteVehicles(list);

  if (incompletes.length === 0) {
    await recalculateUserRemediationFlag(userId);
    return {
      needs_remediation: false,
      done: true,
      active_vehicle: null,
      question: null,
      progress: null,
    };
  }

  const unitsPref = await getUnitsPref(userId);

  let vehicle = incompletes[0];
  vehicle = await maybeRepairDerivedWeeklyHours(userId, vehicle);

  list = await listVehiclesForUser(userId);
  incompletes = orderedIncompleteVehicles(list);
  if (incompletes.length === 0) {
    await recalculateUserRemediationFlag(userId);
    return {
      needs_remediation: false,
      done: true,
      active_vehicle: null,
      question: null,
      progress: null,
    };
  }

  vehicle = incompletes[0];

  const next = nextRemediationQuestionInner(vehicle, unitsPref);

  await recalculateUserRemediationFlag(userId);

  if (!next) {
    // Defensive: incomplete vehicle rows should map to a question after
    // `storedVehicleProfileFieldNeedsRemediationRepair` — if not, keep the
    // user in remediation with a non-null overlay (settings / retry UX).
    console.error('[vehicleRemediation] Incomplete vehicle without snapshot question', {
      userId,
      vehicleId: vehicle.id,
    });
    return {
      needs_remediation: true,
      done: false,
      active_vehicle: { id: vehicle.id, name: vehicle.name },
      question: null,
      progress: null,
    };
  }

  return {
    needs_remediation: true,
    done: false,
    active_vehicle: { id: vehicle.id, name: vehicle.name },
    question: next.question,
    progress: next.progress,
  };
}

export async function submitVehicleRemediationAnswer(
  userId: string,
  questionKey: string,
  value: unknown
): Promise<VehicleRemediationSnapshot> {
  const list = await listVehiclesForUser(userId);
  const incompletes = orderedIncompleteVehicles(list);
  if (incompletes.length === 0) {
    await recalculateUserRemediationFlag(userId);
    return getVehicleRemediationSnapshot(userId);
  }

  const vehicle = incompletes[0];
  const unitsPref = await getUnitsPref(userId);

  const expected = nextRemediationQuestionInner(vehicle, unitsPref);
  if (!expected || expected.question.key !== questionKey) {
    throw new HttpError(409, 'This step is stale — reload the snapshot.');
  }

  if (questionKey === CARAVAN_DUMP_STATION_GATE_KEY) {
    const raw = typeof value === 'string' ? value : '';
    if (raw !== 'yes' && raw !== 'no') throw new HttpError(400, 'Pick yes or no.');
    await updateVehicle(userId, vehicle.id, {
      dump_station_tracking_enabled: raw === 'yes',
      ...(raw === 'no' ? { dump_station_interval_days: null } : {}),
    });
  } else {
    const questions = buildVehicleProfileQuestions(unitsPref);
    const question = questions.find((q) => q.key === questionKey);
    if (!question) throw new HttpError(400, `Unknown question ${questionKey}`);

    if (
      !vehicleProfileQuestionAllowsNull(question, vehicle as unknown as Record<string, unknown>) &&
      (value === null || value === undefined || value === '')
    ) {
      throw new HttpError(400, 'This field is required.');
    }

    const parsed = coerceVehicleProfileValue(question, value);
    const patch = {} as Partial<VehicleInput>;
    if (question.key === 'comfortable_range_km' && unitsPref === 'imperial') {
      const km = parsed == null ? null : miToKm(parsed as number);
      patch.comfortable_range_km = km == null ? null : Math.round(km);
    } else if (question.key === 'name') {
      patch.name = parsed as string;
    } else if (question.key === 'travel_style') {
      patch.travel_style = parsed as string;
      const derived = deriveFromTravelStyle(parsed as TravelStyle);
      patch.cruise_max_drive_hours = derived.cruise_max_drive_hours;
      patch.transit_max_drive_hours = derived.transit_max_drive_hours;
      patch.max_drive_hours_per_day = derived.max_drive_hours_per_day;
    } else if (question.key === 'max_consecutive_drive_days') {
      patch.max_consecutive_drive_days = parsed as number | null;
    } else if (question.key === 'dump_station_interval_days') {
      patch.dump_station_interval_days = parsed as number | null;
    }
    const nextDay = (patch.max_drive_hours_per_day as number | undefined) ?? vehicle.max_drive_hours_per_day;
    const nextConsec = patch.max_consecutive_drive_days ?? vehicle.max_consecutive_drive_days;
    if (
      typeof nextDay === 'number' &&
      nextDay > 0 &&
      typeof nextConsec === 'number' &&
      nextConsec > 0
    ) {
      patch.max_drive_hours_per_week = deriveMaxDriveHoursPerWeek(nextDay, nextConsec);
    }
    await updateVehicle(userId, vehicle.id, patch);
  }

  return getVehicleRemediationSnapshot(userId);
}
