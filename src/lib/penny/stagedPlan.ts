import { createHash } from 'node:crypto';
import { z } from 'zod';

/**
 * A "yes" costs no model call.
 *
 * THE INCIDENT (trip 9a3df982, 2026-10-08). Penny asked "Both good?", the
 * driver said "yup", and that one syllable cost a full model call — which then
 * asked ANOTHER confirmation question. "Whatever you choose" worked only on
 * the turn after that.
 *
 * THE DESIGN (Sam, 2026-10-08). When Penny asks a confirmation question she
 * has ALREADY done the work for the "yes" in that same turn — resolved the
 * places with her own recommendation, routed them, queued the writes — and
 * said so structurally by calling `hold_for_confirmation`. The route then
 * STAGES those validated writes on her turn's row (`result_meta.stagedPlan`,
 * a jsonb key: no migration) instead of applying them, and her message is the
 * question. When the driver's next message is a deterministic yes
 * (`classifyReply` in acceptance.ts), the route applies the staged writes
 * through the normal dispatch pipeline and posts one short line — no model
 * call. Anything else leaves the stage behind; it is only ever honoured from
 * the turn IMMEDIATELY before, so a newer turn makes it dead without a write.
 *
 * A stage is also dead when the trip changed underneath it (`tripFingerprint`
 * differs), when it is older than `MAX_STAGE_AGE_MS`, or when the message the
 * yes answers is not the one the stage was asked in.
 *
 * This module is the pure half: the stored shape, the fingerprint, the checks.
 * `server/pennyStage.ts` reads and writes it.
 */

/** A staged write: one validated action, exactly as the loop queued it. */
const stagedActionSchema = z.object({
  name: z.string().min(1).max(64),
  input: z.record(z.unknown()),
});

export const stagedPlanSchema = z.object({
  version: z.literal(1),
  /** The writes the "yes" applies, in the order Penny queued them. */
  actions: z.array(stagedActionSchema).min(1).max(200),
  /** `tripFingerprint` of the trip when the stage was made. */
  fingerprint: z.string().length(64),
  /** Feasibility-gate state of the question turn, replayed by the dispatcher. */
  extractIntentCalled: z.boolean(),
  feasibilityVerdict: z.enum(['fits', 'tight', 'over_budget', 'no_budget']).nullable(),
  /** The message Penny asked it in, as persisted — what the yes must answer. */
  question: z.string(),
  /** What she said she would ask, from hold_for_confirmation. Diagnostic. */
  heldQuestion: z.string().nullable(),
  /**
   * True when the question was asked ON the handoff turn — the first full
   * build. The "yes" that applies it is then the first build too, and gets
   * everything a first build gets (the plan-ready card). Trip 9a3df982 asked
   * its first question on exactly that turn.
   */
  handoff: z.boolean().optional().default(false),
  /** ISO time the stage was made. */
  stagedAt: z.string(),
});

export type StagedPlan = z.infer<typeof stagedPlanSchema>;

/** A stage the driver has not answered within two days is not a live question. */
export const MAX_STAGE_AGE_MS = 48 * 60 * 60 * 1000;

/** What the app says when a yes applied the stage. The plan summary card under it carries the detail. */
export const STAGE_APPLIED_LINE = 'Done — saved as proposed.';

/** The parts of a trip a staged write could depend on. A structural subset of `TripWithLegs`. */
export interface FingerprintTrip {
  start_date_parsed: string | null;
  current_leg_id: string | null;
  daily_drive_hours?: number | null;
  vehicle_id?: string | null;
  legs: ReadonlyArray<{
    id: string;
    sort_order: number;
    leg_type: string | null;
    start_name: string | null;
    end_name: string | null;
    start_lat: number | null;
    start_lng: number | null;
    end_lat: number | null;
    end_lng: number | null;
    distance_km: number | null;
    drive_time_minutes: number | null;
    stops: ReadonlyArray<{
      id: string;
      stop_type: string;
      status: string;
      name: string;
      lat: number | null;
      lng: number | null;
    }>;
    routes: ReadonlyArray<{ id: string; status: string }>;
    tasks: ReadonlyArray<{ id: string; status: string }>;
  }>;
}

/**
 * A hash of everything a staged write could depend on: the legs (ids, order,
 * endpoints, distances), their non-fuel stops, routes and tasks, and the
 * trip's anchor fields. Any change by the driver, or by another turn, moves it.
 *
 * Fuel stops are left OUT on purpose: Finn writes them lazily when the driver
 * merely OPENS a day, and that must not kill a pending "yes" — Penny's staged
 * writes never touch fuel rows (add_stop is locked to 'other').
 */
export function tripFingerprint(trip: FingerprintTrip): string {
  const projection = {
    s: trip.start_date_parsed,
    c: trip.current_leg_id,
    h: trip.daily_drive_hours ?? null,
    v: trip.vehicle_id ?? null,
    l: [...trip.legs]
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((l) => ({
        id: l.id,
        o: l.sort_order,
        t: l.leg_type,
        a: [l.start_name, l.start_lat, l.start_lng],
        b: [l.end_name, l.end_lat, l.end_lng],
        d: [l.distance_km, l.drive_time_minutes],
        s: l.stops
          .filter((s) => s.stop_type !== 'fuel')
          .map((s) => [s.id, s.status, s.name, s.lat, s.lng])
          .sort(),
        r: l.routes.map((r) => [r.id, r.status]).sort(),
        k: l.tasks.map((t) => [t.id, t.status]).sort(),
      })),
  };
  return createHash('sha256').update(JSON.stringify(projection)).digest('hex');
}

export type StageVerdict =
  | { live: true }
  | { live: false; reason: 'no_stage' | 'not_previous_turn' | 'answers_other_message' | 'expired' | 'trip_changed' };

/**
 * Whether a stage may be applied by this reply. Pure: the caller supplies the
 * facts. `stage` is the parsed stage on the trip's latest turn before this one
 * (null when that turn has none or it does not parse); `previousAssistant` is
 * Penny's message right before the driver's reply.
 */
export function judgeStage(input: {
  stage: StagedPlan | null;
  /** True when the stage's turn is the trip's latest turn before this reply. */
  isPreviousTurn: boolean;
  previousAssistant: string | null;
  currentFingerprint: string;
  now: Date;
}): StageVerdict {
  const { stage } = input;
  if (!stage) return { live: false, reason: 'no_stage' };
  if (!input.isPreviousTurn) return { live: false, reason: 'not_previous_turn' };
  if ((input.previousAssistant ?? '').trim() !== stage.question.trim()) {
    return { live: false, reason: 'answers_other_message' };
  }
  const age = input.now.getTime() - new Date(stage.stagedAt).getTime();
  if (!Number.isFinite(age) || age > MAX_STAGE_AGE_MS) return { live: false, reason: 'expired' };
  if (stage.fingerprint !== input.currentFingerprint) return { live: false, reason: 'trip_changed' };
  return { live: true };
}
