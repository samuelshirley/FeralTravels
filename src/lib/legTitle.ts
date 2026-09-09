/**
 * A driving day's title is DERIVED, never authored.
 *
 * It is `start → end`, and both halves are already columns on the row, so a
 * title passed in by anyone is a second copy of a fact — free to disagree with
 * the first. It did: Haiku emitted "Austin → Big Bend (Day 1)" as the title of a
 * leg that ends in Marfa (trip `1b1cc80b`, 2026-09-09), so the itinerary named a
 * destination the day does not reach. The route-continuity repair already
 * rewrites "A → B" titles when it moves a leg's start, which is the same
 * observation made narrowly: if the title has to be recomputed to stay true, it
 * was never input.
 *
 * Rest legs keep their own title — "Girona (base day)" is not a journey and has
 * no second endpoint to derive from.
 *
 * Pure, so both the repo write path and the tests can use it. See CLAUDE.md,
 * "The LLM converts, it does not author".
 */

/** The arrow used between endpoints. One definition, so nothing splits on the wrong glyph. */
export const LEG_TITLE_ARROW = '→';

/**
 * The title for a driving leg. Null when there is not enough to derive one —
 * the caller keeps whatever it already had rather than writing "→" or "Untitled".
 */
export function deriveDriveLegTitle(
  startName: string | null | undefined,
  endName: string | null | undefined
): string | null {
  const start = startName?.trim();
  const end = endName?.trim();
  if (!start || !end) return null;
  return `${start} ${LEG_TITLE_ARROW} ${end}`;
}

/**
 * The title to persist for a leg, given its type and endpoints.
 *
 * @param fallback what the caller would otherwise have written (Penny's title,
 *   or the existing row's). Used for rest legs, and for drive legs whose
 *   endpoints are not both known yet.
 */
export function resolveLegTitle(opts: {
  legType: string | null | undefined;
  startName: string | null | undefined;
  endName: string | null | undefined;
  fallback: string | null | undefined;
}): string | null {
  if (opts.legType === 'rest') return opts.fallback ?? null;
  return deriveDriveLegTitle(opts.startName, opts.endName) ?? opts.fallback ?? null;
}
