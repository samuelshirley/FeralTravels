import { describe, it, expect, vi } from 'vitest';

vi.mock('server-only', () => ({}));
// The builder under test is pure. The writer beside it reaches the database
// and the repos, whose import chain (Auth.js → an extensionless `next/server`)
// cannot resolve under vitest, so those modules are kept out of the graph.
vi.mock('@/server/db/client', () => ({ db: {} }));
vi.mock('@/server/repos/trips', () => ({ getTripFull: vi.fn() }));
vi.mock('@/server/repos/vehicles', () => ({ getVehicleForUser: vi.fn() }));

import { buildSeededTranscript, SEEDED_PENNY_REPLY, type SeededTranscriptFacts } from './seededTranscript';
import { TRIP_INTENT_QUESTION, UNITS_QUESTION } from '@/server/onboarding';
import { computePlanSummary } from '@/lib/penny/planSummary';
import { PLAN_READY_HEADLINE } from '@/lib/planReady';
import { buildVehicleProfileQuestions } from '@/lib/vehicleProfile';
import { formatDate, legDateISO, parseISODate } from '@/lib/dates';
import { seededTripStartISO } from '@/app/api/test/seedDates';
import type { LegWithDetails } from '@/types/trip';

function leg(i: number, start: string, end: string, legType: 'drive' | 'rest', startISO: string): LegWithDetails {
  return {
    id: `leg-${i}`,
    trip_id: 'trip-1',
    sort_order: i,
    leg_type: legType,
    title: `${start} → ${end}`,
    label: null,
    segment_index: null,
    segment_name: null,
    start_name: start,
    end_name: end,
    start_lat: 41.98,
    start_lng: 2.82,
    end_lat: 41.65,
    end_lng: -4.72,
    dates: legDateISO(startISO, i),
    date_iso: legDateISO(startISO, i),
    distance_km: legType === 'drive' ? 420 : null,
    drive_time_minutes: legType === 'drive' ? 280 : null,
    terrain: 'highway',
    overnight: null,
    status: 'planning',
    color: null,
    notes: null,
    parsedNotes: [],
    costs: [],
    links: [],
    routes: [],
    stops: [],
    tasks: [],
  } as unknown as LegWithDetails;
}

function facts(startISO = '2026-09-10', over: Partial<SeededTranscriptFacts> = {}): SeededTranscriptFacts {
  return {
    tripId: 'trip-1',
    startISO,
    paceHours: 8,
    units: 'metric',
    vehicle: { name: 'Hilux', rangeKm: 500 },
    legs: [
      leg(0, 'Girona', 'Salamanca', 'drive', startISO),
      leg(1, 'Salamanca', 'Salamanca', 'rest', startISO),
      leg(2, 'Salamanca', 'Porto', 'drive', startISO),
    ],
    ...over,
  };
}

const NOW = new Date('2026-08-27T12:00:00Z');
const contentOf = (rows: ReturnType<typeof buildSeededTranscript>) => rows.map((r) => r.content).join('\n');

describe('buildSeededTranscript', () => {
  it('writes the rows a real first trip gets, in the order production writes them', () => {
    const rows = buildSeededTranscript(facts(), NOW);
    expect(rows.map((r) => `${r.role}:${r.kind}`)).toEqual([
      'assistant:form_question', // trip_intent
      'user:form_answer',
      'assistant:ai', // the scan receipt
      'assistant:form_question', // units
      'user:form_answer',
      'assistant:form_question', // vehicle name
      'user:form_answer',
      'assistant:form_question', // vehicle range
      'user:form_answer',
      'user:handoff',
      'assistant:plan_ready',
      'assistant:ai', // Penny's reply
    ]);
  });

  it('builds every question from the production constants', () => {
    const rows = buildSeededTranscript(facts(), NOW);
    const [nameQ, rangeQ] = buildVehicleProfileQuestions('metric');
    const questions = rows.filter((r) => r.kind === 'form_question').map((r) => r.content);
    expect(questions).toEqual([TRIP_INTENT_QUESTION.label, UNITS_QUESTION.label, nameQ.label, rangeQ.label]);
  });

  it('puts form_meta on every form_answer, and on nothing else', () => {
    for (const row of buildSeededTranscript(facts(), NOW)) {
      if (row.kind === 'form_answer') {
        expect(row.formMeta, row.content).toBeTruthy();
        expect(row.formMeta?.answerLabel).toBe(row.content);
      } else {
        expect(row.formMeta ?? null).toBeNull();
      }
    }
  });

  it('lights the chips the answers match', () => {
    const rows = buildSeededTranscript(facts(), NOW);
    const answers = rows.filter((r) => r.kind === 'form_answer');
    expect(answers[1].formMeta?.selected).toBe('metric');
    expect(answers[3].content).toBe('500 km');
  });

  it('hands off the opening message plus its origin, as completeOnboarding does', () => {
    const rows = buildSeededTranscript(facts(), NOW);
    const opening = rows[1].content;
    const handoff = rows.find((r) => r.kind === 'handoff');
    expect(handoff?.content).toBe(`${opening}\n\nStarting from: Girona`);
  });

  it('confirms the plan before Penny replies, at the pace the trip was built at', () => {
    const rows = buildSeededTranscript(facts(), NOW);
    const kinds = rows.map((r) => r.kind);
    expect(kinds.indexOf('plan_ready')).toBe(kinds.length - 2);
    const planReady = rows[kinds.indexOf('plan_ready')];
    expect(planReady.content).toContain(PLAN_READY_HEADLINE);
    expect(planReady.content).toContain('8 h of driving, the pace you asked for');
  });

  it('computes the plan summary from the same legs, never invents one', () => {
    const f = facts();
    const reply = buildSeededTranscript(f, NOW).at(-1)!;
    expect(reply.planSummary).toEqual(computePlanSummary({ legs: f.legs, tripStartISO: f.startISO }));
    // Only the reply carries one, as on a real handoff turn.
    for (const row of buildSeededTranscript(f, NOW).slice(0, -1)) expect(row.planSummary ?? null).toBeNull();
  });

  it("records one add_leg per day in changes_made, in replan's legacy envelope", () => {
    const f = facts();
    const reply = buildSeededTranscript(f, NOW).at(-1)!;
    const envelope = JSON.parse(reply.changesMade ?? '{}');
    expect(envelope.changes.map((c: { action: string }) => c.action)).toEqual(['add_leg', 'add_leg', 'add_leg']);
    expect(envelope.changes[2].data.title).toBe('Salamanca → Porto');
  });

  /** The PlanSummary contract: the UI renders the numbers, so the prose states none. */
  it("keeps Penny's reply to one line with no numbers in it", () => {
    const reply = buildSeededTranscript(facts(), NOW).at(-1)!;
    expect(reply.content).toBe(SEEDED_PENNY_REPLY);
    expect(reply.content).not.toMatch(/\d|\n/);
  });

  it('orders created_at the way seq is ordered, and ends no later than now', () => {
    const rows = buildSeededTranscript(facts(), NOW);
    const times = rows.map((r) => (r.createdAt as Date).getTime());
    for (let i = 1; i < times.length; i++) expect(times[i]).toBeGreaterThan(times[i - 1]);
    expect(times.at(-1)).toBeLessThanOrEqual(NOW.getTime());
  });

  it('words the vehicle range in the units the driver picked', () => {
    const rows = buildSeededTranscript(facts('2026-09-10', { units: 'imperial' }), NOW);
    const answers = rows.filter((r) => r.kind === 'form_answer').map((r) => r.content);
    expect(answers).toContain('Imperial (miles)');
    expect(answers).toContain('311 mi');
  });

  it('refuses a trip with no days: that is not a planned trip', () => {
    expect(() => buildSeededTranscript(facts('2026-09-10', { legs: [] }), NOW)).toThrow();
  });
});

/**
 * No written calendar date — moved here from testAccounts.test.ts with the
 * transcript it protected.
 *
 * The admin test-account fixture used to CLONE the source trip's chat rows, so
 * a generated account arrived with a conversation about the day the admin
 * happened to plan their own trip — "setting off Tue 18 Aug", "change this trip
 * to me leaving on September 15th" — above an itinerary the same function had
 * just re-dated to today + 14. It was read, reasonably, as the seeded dates
 * being wrong. They were not; the transcript was, and it got wronger every day
 * the fixture went untouched. `seedDates.ts` argues a fixture must never
 * contain a written date; these tests extend that to the words on screen.
 */
describe('buildSeededTranscript dates', () => {
  it('dates the turns from the start it was given', () => {
    expect(contentOf(buildSeededTranscript(facts('2026-09-10'), NOW))).toContain('Thu 10 Sep');
  });

  it('moves with the seed date rather than describing a fixed day', () => {
    const a = contentOf(buildSeededTranscript(facts('2026-09-10'), NOW));
    const b = contentOf(buildSeededTranscript(facts('2027-03-02'), NOW));
    expect(a).not.toEqual(b);
    expect(b).toContain('Tue 2 Mar');
    expect(b).not.toContain('Sep');
  });

  it('contains no calendar date the caller did not supply', () => {
    const start = seededTripStartISO(NOW);
    const supplied = formatDate(parseISODate(start), 'metric');
    const text = contentOf(buildSeededTranscript(facts(start), NOW)).split(supplied).join('');
    expect(text).not.toMatch(/\b\d{4}-\d{2}-\d{2}\b/);
    expect(text).not.toMatch(
      /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|January|February|March|April|June|July|August|September|October|November|December)\b/
    );
  });

  it('describes the route the trip actually has, not a hardcoded one', () => {
    const start = '2026-09-10';
    const text = contentOf(
      buildSeededTranscript(facts(start, { legs: [leg(0, 'Bilbao', 'Bordeaux', 'drive', start)] }), NOW)
    );
    expect(text).toContain('Bilbao');
    expect(text).toContain('Bordeaux');
    expect(text).not.toContain('Porto');
  });

  it('opens with the greeting a real trip opens with', () => {
    const [first] = buildSeededTranscript(facts(), NOW);
    expect(first.role).toBe('assistant');
    expect(first.kind).toBe('form_question');
    expect(first.content).toBe(TRIP_INTENT_QUESTION.label);
  });
});
