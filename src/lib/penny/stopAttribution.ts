import { haversineKm } from '@/lib/penny/geo';
import { textMentionsPlace } from '@/lib/penny/placeTokens';

/**
 * Who chose this stop — enforced, not requested.
 *
 * THE INCIDENT (trip 9a3df982, 2026-10-08). After "whatever you choose", Penny
 * saved four waypoints she had picked herself, every one with
 * `source: "user"`, as if the driver had added them. The prompt told her to:
 * "When you place a stop … from a resolve_place result, set source="user"".
 * That line is gone, and this is the server half: `source: "user"` survives
 * only when the user can actually be shown to have named the place.
 *
 * `'penny'` already exists in the stops `source` vocabulary (`stopSourceSchema`
 * in `tools/shared.ts`, a free `text` column), so no migration is involved.
 * The value is not rendered by either client today; it is the record of who
 * decided, and Penny reads it back in her context on every later turn.
 */

export interface AttributionInput {
  /** What Penny sent. Only `'user'` is ever rewritten. */
  source: string | null | undefined;
  name: string;
  lat?: number | null;
  lng?: number | null;
  sourceUrl?: string | null;
  /** The driver handed the choice to Penny this turn ("whatever you choose"). */
  delegated: boolean;
  /** Everything the driver wrote that Penny can see: recent chat + this message. */
  userTexts: readonly string[];
  /** Coordinates of Maps links the driver pasted and the server resolved this turn. */
  pastedPoints: ReadonlyArray<{ lat: number; lng: number }>;
}

/** A pasted link resolved to within this distance of the stop is the user naming it. */
const PASTED_POINT_RADIUS_KM = 1;

export type AttributionOutcome =
  | { source: string | null | undefined; rewritten: false }
  | { source: 'penny'; rewritten: true; reason: string };

/**
 * Keep `source: "user"` only when the user named the place: they pasted a link
 * to it (its URL is in their words, or a resolved link lands on it), or they
 * wrote its name. Never on a turn where they handed the choice over.
 */
export function attributeStopSource(input: AttributionInput): AttributionOutcome {
  if (input.source !== 'user') return { source: input.source, rewritten: false };

  if (input.delegated) {
    return {
      source: 'penny',
      rewritten: true,
      reason: 'the user left the choice to you this turn',
    };
  }

  if (input.sourceUrl && input.userTexts.some((t) => t.includes(input.sourceUrl as string))) {
    return { source: input.source, rewritten: false };
  }
  if (input.lat != null && input.lng != null) {
    const { lat, lng } = input;
    if (input.pastedPoints.some((p) => haversineKm(p.lat, p.lng, lat, lng) <= PASTED_POINT_RADIUS_KM)) {
      return { source: input.source, rewritten: false };
    }
  }
  if (input.userTexts.some((t) => textMentionsPlace(t, input.name))) {
    return { source: input.source, rewritten: false };
  }

  return {
    source: 'penny',
    rewritten: true,
    reason: 'the user never named this place',
  };
}

/** The tool_result Penny sees when her `source: "user"` was corrected. */
export function attributionNote(reason: string): string {
  return (
    `Validated and queued, saved with source="penny" because ${reason} — it is your ` +
    `pick, not theirs. Do not describe it as something the user added. Do not re-emit this call.`
  );
}
