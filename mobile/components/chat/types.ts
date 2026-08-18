import type { ChatMessage, PlanSummary } from "@/shared/types/trip";

/**
 * Native mirror of the chat types in src/components/ChatPanel.tsx.
 *
 * These live in their own module (rather than at the top of ChatPanel.tsx like
 * the web) because the SSE transport, the plan-summary card and the panel all
 * need them, and none of those should import each other.
 */

/**
 * Terminal payload the server emits as the `applied` SSE event AND stores on
 * the durable `penny_turns` record. The live stream and the reconcile/heal path
 * both apply it, so a turn looks identical whether the client saw it live or
 * healed it after a crash. See docs/design/penny-turn-resilience.md.
 */
export interface AppliedEvent {
  response: string;
  changes: { changes: unknown[] };
  appliedCount: number;
  failedCount: number;
  failedActions: Array<{ action: string; error: string }>;
  /** DB / feasibility failures — use for user-visible save warnings. */
  persistFailedCount?: number;
  persistFailedActions?: Array<{ action: string; error: string }>;
  /** Exhausted validation retries; not indicative of unsuccessful writes. */
  validationFailures?: Array<{ action: string; error: string }>;
  /** Validated tool actions queued this turn — may exceed `changes.changes`. */
  validatedQueuedCount?: number;
  /** True when an inline plan_fuel_stops lookup wrote stops this turn. */
  fuelStopsChanged: boolean;
  /** Deterministic, DB-derived plan facts (source of truth for numbers). */
  planSummary?: PlanSummary | null;
  truncated: boolean;
}

/**
 * Message delivery lifecycle — mirrors iMessage/WhatsApp status indicators.
 * Each state maps to a real server-side event:
 *   queued     → user sent while Penny was thinking; will fire when Penny finishes
 *   sending    → request fired, waiting for server acknowledgement
 *   delivered  → server persisted the user message (SSE `received` event)
 *   read       → Penny is building context / about to call Claude (SSE `reading` event)
 *   typing     → first text chunk or tool event arrived (Penny is actively responding)
 *   responded  → Penny's full response is complete (SSE `applied` event)
 */
export type DeliveryStatus =
  | "queued"
  | "sending"
  | "delivered"
  | "read"
  | "typing"
  | "responded";

export interface UIMessage extends Omit<ChatMessage, "seq" | "plan_summary"> {
  /** Sequential ordering number — 0 or absent for optimistic (unsaved) messages. */
  seq?: number;
  /** `data:` URIs of images the user attached to this message. */
  imageDataUrls?: string[];
  /**
   * Populated when Penny proposed changes but the server couldn't apply them
   * (unknown action, owner mismatch, DB error). We surface this so the user
   * doesn't see a misleading "Changes applied to trip" badge.
   */
  applyError?: string | null;
  /** When some writes succeeded AND some failed — show success + this warning. */
  partialApplyWarning?: string | null;
  /**
   * Deterministic, DB-derived plan facts for this turn. Optional here because
   * optimistic/streaming messages don't have it yet; persisted + history-loaded
   * messages do. This is the source of truth the card renders — never Penny's
   * prose.
   */
  plan_summary?: PlanSummary | null;
  /**
   * True when the replan response had truncated=true — Penny hit the tool-use
   * iteration cap mid-plan and only persisted partial work. UI-only; not
   * persisted, so historical messages from a reload never show it.
   */
  truncated?: boolean;
  /** True while the stream is still appending paragraphs. */
  streaming?: boolean;
  /** Delivery lifecycle for user messages. */
  deliveryStatus?: DeliveryStatus;
  /**
   * Idempotency key of the replan turn that produced this assistant bubble.
   * Lets the client re-attach to the durable `penny_turns` record and heal a
   * false "Something went wrong" bubble (or finish a queued turn) when the app
   * comes back to the foreground. Session-only — not persisted.
   */
  turnKey?: string;
}

export interface AttachedImage {
  id: string;
  dataUrl: string;
  mediaType: string;
  name: string;
}

export interface ApplyOutcome {
  /** True when at least one write landed — the caller reloads the trip. */
  appliedChanges: boolean;
  /** Red annotation: nothing (or nothing meaningful) could be saved. */
  applyError: string | null;
  /** Amber annotation: some writes landed, some didn't. */
  partialApplyWarning: string | null;
  /** Technical Zod failures aimed at the LLM — logged, never surfaced. */
  validationFailures: Array<{ action: string; error: string }>;
}

/**
 * COPY CAVEAT: the web imports `deriveApplyOutcome` from
 * `src/lib/penny/applyOutcome.ts`, which is NOT part of the shared mirror in
 * this repo (only `src/components/ChatPanel.tsx` was available as the port
 * spec). The *semantics* below are pinned by how ChatPanel consumes the result
 * — appliedChanges drives the trip reload, applyError is the red annotation and
 * suppresses both the success badge and the plan card, partialApplyWarning is
 * the amber one — but the exact user-facing sentences are reconstructed. This
 * is the one place in this port where copy can drift from the web; diff it
 * against src/lib/penny/applyOutcome.ts before shipping.
 */
export function deriveApplyOutcome(ev: AppliedEvent): ApplyOutcome {
  const persistFailedActions = ev.persistFailedActions ?? [];
  const persistFailedCount = ev.persistFailedCount ?? persistFailedActions.length;
  const validationFailures = ev.validationFailures ?? [];
  const appliedChanges = ev.appliedCount > 0;
  const firstFailure =
    persistFailedActions[0]?.error ?? ev.failedActions?.[0]?.error ?? null;

  let applyError: string | null = null;
  let partialApplyWarning: string | null = null;

  if (persistFailedCount > 0 && appliedChanges) {
    partialApplyWarning = `Saved ${ev.appliedCount} change${
      ev.appliedCount === 1 ? "" : "s"
    }, but ${persistFailedCount} couldn't be applied${
      firstFailure ? `: ${firstFailure}` : "."
    }`;
  } else if (persistFailedCount > 0) {
    applyError = `Penny's changes couldn't be saved${
      firstFailure ? `: ${firstFailure}` : "."
    }`;
  } else if (!appliedChanges && (ev.validatedQueuedCount ?? 0) > 0) {
    // She queued validated actions but none of them reached the database.
    applyError = "Penny proposed changes but none could be applied to your trip.";
  }

  return { appliedChanges, applyError, partialApplyWarning, validationFailures };
}
