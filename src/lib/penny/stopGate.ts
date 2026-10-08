import type { PennyContext } from '@/lib/penny/context';
import type { ValidatedAction } from '@/lib/penny/tools';
import { haversineKm } from '@/lib/penny/geo';
import { namesSamePlace } from '@/lib/penny/placeTokens';
import { notDrivableStopMessage } from '@/lib/penny/unsourcedFacts';
import { attributeStopSource, attributionNote } from '@/lib/penny/stopAttribution';

/**
 * The in-loop check every validated `add_stop` / `update_stop` passes through
 * before it is queued, for the two rules that need more than the tool's own
 * schema can see:
 *
 *  - a stop may not be placed on a place resolve_place flagged as not drivable
 *    this turn (a race course, a hiking area — `unsourcedFacts.ts`);
 *  - `source: "user"` is kept only for a place the user named
 *    (`stopAttribution.ts`), and is rewritten to `"penny"` otherwise.
 *
 * Pure apart from that one rewrite, which mutates the action's own parsed
 * input — a fresh object from Zod that nothing else holds yet — so what is
 * queued, traced and dispatched is the corrected value.
 */

/** A place resolve_place flagged this turn. */
export interface NotDrivablePlace {
  lat: number;
  lng: number;
  label: string;
  reason: string;
}

/** A stop this close to a flagged place is ON it. */
const NOT_DRIVABLE_RADIUS_KM = 0.3;

export interface StopGateCtx {
  context: Pick<PennyContext, 'legs'>;
  notDrivablePlaces: readonly NotDrivablePlace[];
  delegated: boolean;
  userTexts: readonly string[];
  pastedPoints: ReadonlyArray<{ lat: number; lng: number }>;
}

export interface StopGateOutcome {
  /** The in-loop rejection Penny sees, or null to queue the action. */
  rejected: string | null;
  /** A tool_result to send instead of the default "Validated and queued". */
  note: string | null;
}

const PASS: StopGateOutcome = { rejected: null, note: null };

function flaggedAt(
  places: readonly NotDrivablePlace[],
  name: string,
  lat: number | null | undefined,
  lng: number | null | undefined,
): NotDrivablePlace | null {
  for (const p of places) {
    if (lat != null && lng != null && haversineKm(p.lat, p.lng, lat, lng) <= NOT_DRIVABLE_RADIUS_KM) {
      return p;
    }
    if (namesSamePlace(p.label, name) && namesSamePlace(name, p.label)) return p;
  }
  return null;
}

export function gateStopAction(action: ValidatedAction, ctx: StopGateCtx): StopGateOutcome {
  if (action.name === 'add_stop') {
    const d = action.input.data;
    const flagged = flaggedAt(ctx.notDrivablePlaces, d.name, d.lat, d.lng);
    if (flagged) {
      return { rejected: notDrivableStopMessage(d.name, flagged.label, flagged.reason), note: null };
    }
    const outcome = attributeStopSource({
      source: d.source,
      name: d.name,
      lat: d.lat,
      lng: d.lng,
      sourceUrl: d.source_url,
      delegated: ctx.delegated,
      userTexts: ctx.userTexts,
      pastedPoints: ctx.pastedPoints,
    });
    if (!outcome.rewritten) return PASS;
    d.source = outcome.source;
    return { rejected: null, note: attributionNote(outcome.reason) };
  }

  if (action.name === 'update_stop') {
    const d = action.input.data;
    const existing = ctx.context.legs
      .flatMap((l) => l.stops)
      .find((s) => s.id === action.input.stop_id);
    const name = d.name ?? existing?.name ?? '';
    if (d.lat != null && d.lng != null) {
      const flagged = flaggedAt(ctx.notDrivablePlaces, name, d.lat, d.lng);
      if (flagged) {
        return { rejected: notDrivableStopMessage(name, flagged.label, flagged.reason), note: null };
      }
    }
    if (d.source !== 'user') return PASS;
    const outcome = attributeStopSource({
      source: d.source,
      name,
      lat: d.lat ?? existing?.lat,
      lng: d.lng ?? existing?.lng,
      sourceUrl: d.source_url,
      delegated: ctx.delegated,
      userTexts: ctx.userTexts,
      pastedPoints: ctx.pastedPoints,
    });
    if (!outcome.rewritten) return PASS;
    d.source = outcome.source;
    return { rejected: null, note: attributionNote(outcome.reason) };
  }

  return PASS;
}
