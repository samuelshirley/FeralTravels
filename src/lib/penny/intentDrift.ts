import { namesSamePlace, textMentionsPlace } from '@/lib/penny/placeTokens';

/**
 * No silent drops between two `extract_trip_intent` calls on one trip.
 *
 * THE INCIDENT (trip 9a3df982, 2026-10-08). Picos de Europa was a mandatory
 * waypoint in Penny's first `extract_trip_intent`. Two turns later she called
 * it again without it, built the plan, and said nothing — the driver found out
 * by reading the itinerary. Dropping a stop can be the right call (the
 * feasibility rules tell her to, as a last resort); doing it without a word is
 * not.
 *
 * The parse used to be a planning artifact nobody kept. Now each turn that
 * extracts an intent records its place names on its own `penny_turns` row
 * (`result_meta.tripIntent`, a jsonb key — no migration), so the next one has
 * something to compare against. A place that disappears earns a warning inside
 * the tool result ("tell the user why"), and if her reply still never names it
 * the server says so itself, the same way it appends a correction when every
 * change was rejected.
 */

/** The intent fields this module reads — a subset of `ExtractTripIntentInput`. */
export interface IntentPlaces {
  origin: string;
  destination: string;
  mandatory_waypoints: ReadonlyArray<{ name: string }>;
}

/** Stored on `penny_turns.result_meta.tripIntent`. */
export interface StoredTripIntent {
  places: string[];
}

/**
 * The places a driver asked for: every mandatory waypoint, plus the
 * destination when it is not simply the origin (a loop back home is not a
 * place anyone "asked to visit").
 */
export function intentPlaceNames(intent: IntentPlaces): string[] {
  const names = intent.mandatory_waypoints.map((w) => w.name.trim()).filter(Boolean);
  const dest = intent.destination.trim();
  if (dest && !namesSamePlace(dest, intent.origin) && !names.some((n) => namesSamePlace(dest, n))) {
    names.push(dest);
  }
  return names;
}

/**
 * Places in `previous` that the new intent no longer carries anywhere — not as
 * a waypoint, not as the destination, not as the origin. Order kept, duplicates
 * collapsed.
 */
export function droppedPlaces(previous: readonly string[], next: IntentPlaces): string[] {
  const kept = [next.origin, next.destination, ...next.mandatory_waypoints.map((w) => w.name)];
  const dropped: string[] = [];
  for (const name of previous) {
    if (kept.some((k) => namesSamePlace(name, k) || namesSamePlace(k, name))) continue;
    if (dropped.some((d) => namesSamePlace(name, d))) continue;
    dropped.push(name);
  }
  return dropped;
}

/** Union of place lists, first spelling wins. */
export function mergePlaceNames(...lists: ReadonlyArray<readonly string[]>): string[] {
  const out: string[] = [];
  for (const list of lists) {
    for (const name of list) {
      if (!out.some((o) => namesSamePlace(name, o) || namesSamePlace(o, name))) out.push(name);
    }
  }
  return out;
}

/** The warning inside extract_trip_intent's tool result. */
export function dropWarning(dropped: readonly string[]): string {
  const list = dropped.join(', ');
  return (
    `DROPPED: ${list} ${dropped.length === 1 ? 'was' : 'were'} in this trip's previous plan and ` +
    `${dropped.length === 1 ? 'is' : 'are'} not in this one. If you are dropping ` +
    `${dropped.length === 1 ? 'it' : 'them'} on purpose, you MUST say so in your reply — name ` +
    `${dropped.length === 1 ? 'it' : 'each one'} and say why. If you did not mean to, call ` +
    `extract_trip_intent again with ${dropped.length === 1 ? 'it' : 'them'} included.`
  );
}

/** The dropped places Penny's reply never mentions. */
export function unmentionedDrops(reply: string, dropped: readonly string[]): string[] {
  return dropped.filter((name) => !textMentionsPlace(reply, name));
}

/** The server's own line when she did not say it. */
export function dropNotice(names: readonly string[]): string {
  return `No longer in the plan: ${names.join(', ')}.`;
}

/** The same, on a held turn: the plan has not changed yet, the proposal drops them. */
export function dropProposalNotice(names: readonly string[]): string {
  return `This leaves out: ${names.join(', ')}.`;
}
