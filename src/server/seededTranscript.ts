import 'server-only';
import { db } from '@/server/db/client';
import { chatHistory } from '@/server/db/schema';
import { getTripFull } from '@/server/repos/trips';
import { getVehicleForUser } from '@/server/repos/vehicles';
import { getUnitsPref } from '@/server/repos/users';
import {
  TRIP_INTENT_QUESTION,
  UNITS_QUESTION,
  handoffIntent,
  intentScanNote,
  unitsAnswerLabel,
} from '@/server/onboarding';
import { buildFormMeta, type AnsweredQuestionShape } from '@/lib/onboardingForm';
import {
  DEFAULT_MAX_DRIVE_HOURS_PER_DAY,
  buildVehicleProfileQuestions,
  humanizeVehicleProfileAnswer,
} from '@/lib/vehicleProfile';
import { formatDate, parseISODate } from '@/lib/dates';
import { kmToMi } from '@/lib/units';
import type { UnitsPref } from '@/lib/units';
import { planReadyText } from '@/lib/planReady';
import { computePlanSummary } from '@/lib/penny/planSummary';
import { actionToLegacyChange } from '@/lib/penny/legacyChange';
import type { ValidatedAction } from '@/lib/penny/tools';
import type { AddLegInput } from '@/lib/penny/tools/addLeg';
import type { LegWithDetails } from '@/types/trip';

/**
 * The chat a real planned trip has, written onto a seeded one.
 *
 * A trip a person planned always carries the conversation that planned it, so
 * it never opens on Penny's "START HERE" empty state. A seeded trip with legs
 * and no chat did, which made every seeded account a state no real user
 * reaches. Every seeder that leaves a trip with a finished plan calls
 * `writeSeededTranscript`; `src/lib/seededTranscriptGuard.test.ts` fails the
 * suite when one does not.
 *
 * WHICH PATH IT MIRRORS — the cheapest real one, the first trip of a new
 * account whose opening message named the origin, an exact start date and a
 * pace, so the scan skipped `trip_origin`, `trip_date` and `trip_pace`
 * (`submitAnswer`, the trip_intent branch, in src/server/onboarding.ts):
 *
 *   form_question / form_answer   trip_intent        (writeQA)
 *   ai                            "Got it — …"       (the scan receipt)
 *   form_question / form_answer   units_pick         (writeQA)
 *   form_question / form_answer   vehicle name       (writeQA, card half 1)
 *   form_question / form_answer   vehicle range      (writeQA, card half 2)
 *   handoff                       the stored intent  (api/trip/replan, handoff: true)
 *   plan_ready                    planReadyText      (api/trip/replan, first build)
 *   ai                            Penny's reply, changes_made + plan_summary
 *
 * The vehicle step is the composite card (`buildVehicleSetupQuestion`), but it
 * persists the two SINGLE-step questions, not the card's own label — so the
 * rows are built from `buildVehicleProfileQuestions`, exactly as `submitAnswer`
 * writes them.
 *
 * FIXED TEXT, NO AI CALL: seeding stays free and deterministic. Every question
 * is the production constant or builder; every date is derived from the trip's
 * start; the plan summary is COMPUTED from the seeded legs; Penny's reply
 * states no number or date, because the UI renders the summary for those (see
 * PlanSummary in src/types/trip.ts).
 */

export type SeededChatRow = typeof chatHistory.$inferInsert;

export interface SeededTranscriptFacts {
  tripId: string;
  /** trips.start_date_parsed. */
  startISO: string;
  /** trips.daily_drive_hours — the pace the opening message named. */
  paceHours: number;
  /** What the driver answered on the units step. */
  units: UnitsPref;
  vehicle: { name: string; rangeKm: number };
  /** The seeded legs as `getTripFull` returns them, in sort order. */
  legs: LegWithDetails[];
}

/**
 * Penny's reply to the handoff. One line, and no numbers or dates in it: the
 * plan summary under it carries those, computed rather than written.
 */
export const SEEDED_PENNY_REPLY = 'Here’s your route, day by day.';

/** The `add_leg` call that would have written this leg. */
function addLegActionFor(leg: LegWithDetails): ValidatedAction {
  const input: AddLegInput = {
    title: leg.title,
    leg_type: leg.leg_type,
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
    // Not Penny's to write (`unsourcedFieldSchema` in tools/shared.ts), so the
    // add_leg that would have written this leg carries none.
    terrain: undefined,
    overnight: leg.overnight,
    color: leg.color,
    notes: leg.parsedNotes,
    sort_order: leg.sort_order,
    segment_index: leg.segment_index,
    segment_name: leg.segment_name,
  };
  return { name: 'add_leg', input };
}

/**
 * The chat_history rows, in `seq` order, for a seeded trip. Pure.
 *
 * `createdAt` climbs one second a row and ends at `now`, so the `created_at`
 * order `getChatHistory` sorts by equals the `seq` order `getChatPage` sorts
 * by — and every row is in the past, so a message sent after seeding still
 * lands below the transcript.
 */
export function buildSeededTranscript(
  facts: SeededTranscriptFacts,
  now: Date = new Date(),
): SeededChatRow[] {
  const { tripId, startISO, paceHours, units, vehicle, legs } = facts;
  if (legs.length === 0) throw new Error('buildSeededTranscript: a planned trip has legs');

  const origin = legs[0].start_name?.trim() || legs[0].title;
  const last = legs[legs.length - 1];
  const destination = last.end_name?.trim() || last.title;
  // A first trip has not answered the units step when the scan receipt is
  // written, so production formats that date metric; the opening message is
  // written the same way so the two agree.
  const when = formatDate(parseISODate(startISO), 'metric');
  const opening = `${origin} to ${destination}, leaving ${when}, ${paceHours} h of driving a day.`;

  const [nameQ, rangeQ] = buildVehicleProfileQuestions(units);
  const shownRange =
    units === 'imperial' ? Math.round(kmToMi(vehicle.rangeKm)!) : vehicle.rangeKm;
  const rangeLabel = humanizeVehicleProfileAnswer(rangeQ, shownRange, units);

  const qa = (
    question: AnsweredQuestionShape,
    answer: string,
    rawValue: unknown,
  ): Omit<SeededChatRow, 'createdAt'>[] => [
    { tripId, role: 'assistant', kind: 'form_question', content: question.label },
    {
      tripId,
      role: 'user',
      kind: 'form_answer',
      content: answer,
      formMeta: buildFormMeta(question, answer, rawValue),
    },
  ];

  const note = intentScanNote({
    originPlace: origin,
    dailyDriveHours: paceHours,
    startISO,
    units: 'metric',
  });

  const rows: Omit<SeededChatRow, 'createdAt'>[] = [
    ...qa(TRIP_INTENT_QUESTION, opening, opening),
    ...(note ? [{ tripId, role: 'assistant', kind: 'ai', content: note }] : []),
    ...qa(UNITS_QUESTION, unitsAnswerLabel(units), units),
    ...qa(nameQ, vehicle.name, vehicle.name),
    ...qa(rangeQ, rangeLabel, shownRange),
    { tripId, role: 'user', kind: 'handoff', content: handoffIntent(opening, origin) },
    {
      tripId,
      role: 'assistant',
      kind: 'plan_ready',
      content: planReadyText(paceHours, DEFAULT_MAX_DRIVE_HOURS_PER_DAY),
    },
    {
      tripId,
      role: 'assistant',
      kind: 'ai',
      content: SEEDED_PENNY_REPLY,
      changesMade: JSON.stringify({
        changes: legs.map((leg) => actionToLegacyChange(addLegActionFor(leg))),
      }),
      planSummary: computePlanSummary({ legs, tripStartISO: startISO }),
    },
  ];

  const end = now.getTime();
  return rows.map((row, i) => ({
    ...row,
    createdAt: new Date(end - (rows.length - 1 - i) * 1000),
  }));
}

/**
 * Read the seeded trip back through the repos and write its transcript. Call
 * it LAST in a seeder — after the legs, the vehicle and the pace are on the
 * trip — so the transcript describes the trip that exists.
 */
export async function writeSeededTranscript(tripId: string): Promise<void> {
  const trip = await getTripFull(tripId);
  if (!trip) throw new Error(`writeSeededTranscript: trip ${tripId} not found`);
  if (trip.daily_drive_hours == null) {
    throw new Error('writeSeededTranscript: seed the pace the transcript says was asked for');
  }
  const vehicle = trip.vehicle_id ? await getVehicleForUser(trip.user_id, trip.vehicle_id) : null;
  if (!vehicle || vehicle.range_km == null) {
    throw new Error('writeSeededTranscript: a planned trip has a vehicle with a range');
  }

  const rows = buildSeededTranscript({
    tripId,
    startISO: trip.start_date_parsed,
    paceHours: trip.daily_drive_hours,
    units: await getUnitsPref(trip.user_id),
    vehicle: { name: vehicle.name, rangeKm: vehicle.range_km },
    legs: trip.legs,
  });
  // One row at a time: `seq` is a serial, and one insert per row is what
  // guarantees it is handed out in this order.
  for (const row of rows) await db.insert(chatHistory).values(row);
}
