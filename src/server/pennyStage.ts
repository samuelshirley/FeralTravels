import 'server-only';
import type { ReplanResult } from '@/lib/claude';
import { buildPennyContext } from '@/lib/penny/context';
import { classifyReply, type AcceptanceKind } from '@/lib/penny/acceptance';
import {
  judgeStage,
  stagedPlanSchema,
  tripFingerprint,
  STAGE_APPLIED_LINE,
  type StagedPlan,
  type StageVerdict,
} from '@/lib/penny/stagedPlan';
import { ACTION_TOOL_NAMES, VALIDATORS, type ValidatedAction } from '@/lib/penny/tools';
import { zodErrorToFeedback } from '@/lib/penny/tools/shared';
import { getPreviousTurn } from '@/server/repos/pennyTurns';
import { getTripFull } from '@/server/repos/trips';

/**
 * The I/O half of a staged "yes" (the pure half, and the why, is
 * `lib/penny/stagedPlan.ts`): find the live stage a reply would confirm, build
 * a stage from a held turn, and turn a confirmed stage into the same
 * `ReplanResult` the dispatcher already applies — so a "yes" goes through the
 * exact pipeline a model turn does (feasibility gate, contiguity gate,
 * schedule rebuild, continuity repair, plan summary), with no model call.
 */

export interface LiveStage {
  stage: StagedPlan;
  /** The question turn that holds it. */
  stageTurnId: string;
  kind: AcceptanceKind;
}

/**
 * The stage `message` would confirm, or null. Null unless the message is a
 * deterministic yes (`classifyReply`) AND the stage passes every check in
 * `judgeStage`: on the turn right before, asked in the message the reply
 * answers, under 48 h old, and the trip unchanged since.
 *
 * `beforeTurnId` is the reply's own turn when it has one (null in the request,
 * before the row exists). `previousAssistant` is Penny's message right before
 * the reply.
 */
export async function findLiveStage(input: {
  tripId: string;
  message: string;
  beforeTurnId: string | null;
  previousAssistant: string | null;
  now?: Date;
}): Promise<LiveStage | null> {
  const kind = classifyReply(input.message);
  if (!kind) return null;
  const previous = await getPreviousTurn(input.tripId, input.beforeTurnId);
  if (!previous || previous.status !== 'done') return null;
  const parsed = stagedPlanSchema.safeParse(previous.result_meta?.stagedPlan);
  if (!parsed.success) return null;
  const trip = await getTripFull(input.tripId);
  if (!trip) return null;
  const verdict: StageVerdict = judgeStage({
    stage: parsed.data,
    isPreviousTurn: true,
    previousAssistant: input.previousAssistant,
    currentFingerprint: tripFingerprint(trip),
    now: input.now ?? new Date(),
  });
  return verdict.live ? { stage: parsed.data, stageTurnId: previous.id, kind } : null;
}

/** Build the stage a held turn writes onto its own row. Null when the trip has gone. */
export async function buildStage(input: {
  tripId: string;
  actions: ValidatedAction[];
  extractIntentCalled: boolean;
  feasibilityVerdict: StagedPlan['feasibilityVerdict'];
  question: string;
  heldQuestion: string | null;
  /** The question turn is the handoff (first full build). */
  handoff: boolean;
}): Promise<StagedPlan | null> {
  const trip = await getTripFull(input.tripId);
  if (!trip) return null;
  return {
    version: 1,
    // Round-tripped through JSON here so what is stored is exactly what will
    // be re-validated later (undefined keys dropped, no class instances).
    actions: JSON.parse(JSON.stringify(input.actions)) as StagedPlan['actions'],
    fingerprint: tripFingerprint(trip),
    extractIntentCalled: input.extractIntentCalled,
    feasibilityVerdict: input.feasibilityVerdict,
    question: input.question,
    heldQuestion: input.heldQuestion,
    handoff: input.handoff,
    stagedAt: new Date().toISOString(),
  };
}

/**
 * The confirmed stage as a `ReplanResult`. Every staged write is RE-VALIDATED
 * against the trip as it is now — the server re-validates before persisting,
 * whatever it validated before — and anything that no longer passes is
 * reported as a failure rather than applied. The trip is unchanged (the
 * fingerprint matched), so in practice this is the same answer as before.
 */
export async function stagedReplanResult(
  live: LiveStage,
  tripId: string,
  userId: string
): Promise<ReplanResult> {
  const context = await buildPennyContext(tripId, userId);
  if (!context) throw new Error('Trip not found');

  const validatedActions: ValidatedAction[] = [];
  const failedValidations: Array<{ tool: string; error: string }> = [];
  for (const staged of live.stage.actions) {
    const factory = VALIDATORS[staged.name];
    if (!factory || !ACTION_TOOL_NAMES.has(staged.name)) {
      failedValidations.push({ tool: staged.name, error: 'Not an action tool.' });
      continue;
    }
    const parsed = factory(context).safeParse(staged.input);
    if (!parsed.success) {
      failedValidations.push({ tool: staged.name, error: zodErrorToFeedback(parsed.error) });
      continue;
    }
    const action = { name: staged.name, input: parsed.data } as ValidatedAction;
    // "Whatever you choose" confirms Penny's picks AS hers: a stop it applies
    // is never the user's (lib/penny/stopAttribution.ts).
    if (
      live.kind === 'delegate' &&
      (action.name === 'add_stop' || action.name === 'update_stop') &&
      action.input.data.source === 'user'
    ) {
      action.input.data.source = 'penny';
    }
    validatedActions.push(action);
  }

  return {
    response: STAGE_APPLIED_LINE,
    validatedActions,
    retryCount: 0,
    failedValidations,
    truncated: false,
    leakRetryCount: 0,
    leakSanitized: false,
    extractIntentCalled: live.stage.extractIntentCalled,
    fuelPlanRan: false,
    feasibilityVerdict: live.stage.feasibilityVerdict,
    toolTrace: [],
    turnTrace: { prompt_hash: 'staged', calls: [] },
    acceptance: live.kind,
    held: false,
    holdQuestion: null,
    tripIntent: null,
    droppedPlaces: [],
  };
}
