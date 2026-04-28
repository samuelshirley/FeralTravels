# Penny Tool-Use Migration

**Status:** Proposal. Not yet approved or implemented.

**Last updated:** 2026-04-28.

---

## TL;DR

Penny currently emits actions as a JSON code block inside a free-text response. We regex-extract it, `JSON.parse` it, cast it to `any[]`, and validate fields ad hoc inside each action's dispatch branch. There's no schema validation, no domain-rule validation, and no retry on failure. This is the root cause of the "21-hour drive on day 2" bug: nothing rejects the leg.

Migration proposal:

1. **Convert action emission to Anthropic tool use.** Each action (`add_leg`, `update_leg`, `add_route`, etc.) becomes a tool with a JSON Schema `input_schema`. Claude returns `tool_use` blocks instead of a JSON code block. Malformed structure becomes impossible at the API boundary.
2. **Add a Zod validator per tool, including domain rules.** `drive_time_minutes` ≤ `vehicle.max_drive_hours_per_day * 60`, dates contiguous, fuel-leg distance ≤ effective range, etc. Cross-field rules go in `.refine()`.
3. **Retry on validation failure.** When Zod rejects a tool call, send the validation error back to Claude as `tool_result` with `is_error: true`. Claude corrects and re-emits. Cap at 2 retries per turn.
4. **Shrink the system prompt.** Tool definitions replace the giant `<tool_schema>` and `<output_contract>` blocks. The prompt becomes mostly *style* and *intent*, not field reference.

This is a focused refactor of `src/lib/claude.ts` and `src/app/api/trip/replan/route.ts`. It does not change the database schema, the UI, or the action surface (same actions, same fields, same dispatch). It changes *how* Claude communicates them.

---

## Current architecture

(Audit findings, with file:line refs.)

**Pipeline:**

1. Client POSTs to `/api/trip/replan` with `{ tripId, message, images }`.
2. Route handler (`src/app/api/trip/replan/route.ts:42`) validates input with Zod (`route.ts:33–40`), enforces hourly request cap and daily $-cap (`route.ts:69–89`), persists the user message, then calls `replan()` from `src/lib/claude.ts`.
3. `replan()` (`claude.ts:134`) builds context via `buildPennyContext`, sends it to Anthropic with a single system prompt (`claude.ts:17–125`) that describes the action JSON shapes in English inside a `<tool_schema>` block.
4. Claude's text response is regex-matched for ` ```json ... ``` ` (`claude.ts:201`), `JSON.parse`d (`claude.ts:207`), and returned as `unknown` typed `changes`.
5. Route handler narrows it manually as `{ changes?: Array<Record<string, any>> }` (`route.ts:102–105`), iterates, switches on `change.action`, and dispatches (`route.ts:107–305`).
6. Each branch does ad hoc validation (`route.ts:115`, `223`, `226`) and coerces `change.data` fields by hand. Failures push to `failedActions`. Successes increment `appliedCount`.
7. Response: `{ response, changes, appliedCount, failedCount, failedActions }`.

**Where structural validation happens today:**

- Anthropic input (user-side): Zod, well-validated (`route.ts:33–40`). Good.
- Penny output: regex-extract + `JSON.parse` + try/catch + `console.error`. **No schema validation.** If parse fails, `changes` is silently `null` and the user sees the conversational reply with no indication the AI tried to mutate anything.
- Each action branch: ad hoc `if (typeof x !== 'string') throw new Error(...)`. Validates structurally. **Does not validate any domain rules.**

**Where domain rules live today:**

- Soft text guidance in the system prompt (e.g. `claude.ts:117`: "Pace each leg at the vehicle's max_drive_hours_per_day ... Don't exceed it unless the user explicitly says otherwise"). LLM treats this as preference.
- `plan_fuel_stops` server expansion (`route.ts:353–408`) computes correct stop spacing — good example of moving a deterministic rule into TypeScript instead of trusting the LLM.
- That's it. `add_leg` writes whatever `drive_time_minutes` Claude emits, full stop.

**Key dependencies already in place:**

- Zod 3.25.76 (`package.json:33`).
- Anthropic SDK 0.30.0 (`package.json:19`) — supports tool use and `tool_choice`.
- Per-user usage logging via `logAnthropicUsage` (`claude.ts:175`, `186`) — good for tracking retry costs.

---

## Why the current architecture can't catch the 21-hour bug

The bug, concretely: Sam's vehicle has `max_drive_hours_per_day: 6`. Sam asks for a plan to Berlin. Penny emits an `add_leg` for "Day 2" with `drive_time_minutes: 1260` (21h). The leg gets saved. UI shows 21h.

Why nothing stopped it:

- **Prompt-level**: the rule is phrased as "Don't exceed it unless the user explicitly says otherwise." LLMs treat soft language as overridable. Claude rationalized that the user wanted a plan, exceeding 6h was implicitly authorized.
- **Schema-level**: the action schema is a text description in the system prompt. There's no JSON Schema constraint on `drive_time_minutes`. It can be 1260, 12600, "21 hours" as a string — the prompt doesn't say.
- **Parser-level**: regex+`JSON.parse` accepts anything that's valid JSON.
- **Dispatcher-level**: the `add_leg` branch in `route.ts:109–138` checks `title` is a non-empty string. It does not look at `drive_time_minutes` at all.
- **Database-level**: schema allows any integer.

So the bug isn't a one-line fix. It's a missing layer. The migration adds that layer.

---

## Target architecture

```
client
  → POST /api/trip/replan
  → input zod (unchanged)
  → spend caps (unchanged)
  → buildPennyContext (unchanged)
  → claude.replan()
       ├── client.messages.create({ ..., tools: [...] })
       ├── for each tool_use block:
       │     ├── lookup zod validator for that tool
       │     ├── parse → ok? continue. fail? collect error.
       │     └── on any errors: send tool_result(is_error=true) back, retry (up to 2x)
       └── return { conversationalText, validatedActions[] }
  → dispatcher (unchanged structure, but now consumes typed objects)
       └── apply each action via existing repos
```

**What changes:**

- `claude.ts` — tool definitions, tool_use loop, retry handling. ~50% rewrite.
- `route.ts` — dispatcher consumes typed tool inputs instead of `Record<string, any>`. The switch stays; the casts go away.
- `src/lib/penny/tools/` — *new directory.* One file per tool definition: `addLeg.ts`, `updateLeg.ts`, etc. Each exports `{ definition, validator, name }` where `definition` is the Anthropic tool spec and `validator` is the Zod schema.
- System prompt shrinks: drop `<tool_schema>` and `<output_contract>` (replaced by tool definitions). Keep `<role>`, `<scope>`, `<style>`, `<context_facts>`, and the planning-rules sections (those are *intent*, not *schema*).

**What does NOT change:**

- Database schema.
- The set of actions Penny can take (same names, same fields).
- The UI.
- The dispatcher logic (it still switches on action name).
- Error reporting to the client (`appliedCount` / `failedCount` / `failedActions` stays).
- `plan_fuel_stops` server expansion — that's a good pattern, keep it.

---

## Action-by-action migration

Twelve actions in the current schema. Each becomes a tool. Domain rules summarized; full Zod in the implementation.

| Action | Notable domain rules to enforce in Zod |
|---|---|
| `add_leg` | `drive_time_minutes ≤ vehicle.max_drive_hours_per_day * 60` (cross-field); `distance_km > 0`; lat/lng bounds; `status ∈ enum`. |
| `update_leg` | Same drive-time rule applied to the proposed update. Field whitelist matches `legColumnMap` (`route.ts:147–163`). |
| `delete_leg` | Just `leg_id: number`. No domain rules beyond ownership (handled in dispatcher). |
| `add_route` | `surface ∈ {paved,gravel,mix}`; `links[].type ∈ enum`; `links[].url` is a real URL; if `end_lat`/`end_lng` set, both must be set. |
| `update_route` | Subset of `add_route` fields + `status ∈ {option,selected,dismissed}`. |
| `delete_route` | `route_id: number`. |
| `add_stop` | `stop_type ∈ enum`; if `stop_type === 'fuel'`, `fuel_type` required and matches `vehicle.fuel_type` if known; `distance_from_start_km ≤ leg.distance_km` (cross-field). |
| `update_stop` | Subset + `status ∈ enum`. |
| `delete_stop` | `stop_id: number`. |
| `plan_fuel_stops` | `leg_id: number`. Server already validates the leg has distance > effective range (`route.ts:374`). |
| `add_task` | `priority ∈ {low,normal,high}`; `reference_url` is a URL if present. |
| `update_task` | `status ∈ {open,answered,dismissed}`. |

The cross-field rules (`drive_time_minutes` vs vehicle, `distance_from_start_km` vs leg) need access to context. Two options:

**Option A:** Pass context into Zod via a factory function:
```ts
const addLegValidator = (ctx: PennyContext) => z.object({...}).refine(d => d.drive_time_minutes <= ctx.vehicle.max_drive_hours_per_day * 60, "exceeds daily limit");
```

**Option B:** Validate structure with static Zod, then run cross-field checks in a separate pass.

I'd go with **A** — keeps validation in one place per action, error message is uniform. Costs a slight indirection (validators are factories, not constants).

---

## Zod schema layout

```
src/lib/penny/tools/
├── index.ts              # registry: name → { definition, validator }
├── shared.ts             # shared subschemas (latLng, urlString, statusEnum, …)
├── addLeg.ts
├── updateLeg.ts
├── deleteLeg.ts
├── addRoute.ts
├── updateRoute.ts
├── deleteRoute.ts
├── addStop.ts
├── updateStop.ts
├── deleteStop.ts
├── planFuelStops.ts
├── addTask.ts
└── updateTask.ts
```

Each file looks like:

```ts
import { z } from 'zod';
import type Anthropic from '@anthropic-ai/sdk';
import type { PennyContext } from '@/lib/penny/context';

export const addLegInput = z.object({
  title: z.string().min(1),
  start_name: z.string().nullish(),
  end_name: z.string().nullish(),
  start_lat: z.number().min(-90).max(90).nullish(),
  start_lng: z.number().min(-180).max(180).nullish(),
  end_lat: z.number().min(-90).max(90).nullish(),
  end_lng: z.number().min(-180).max(180).nullish(),
  distance_km: z.number().positive().nullish(),
  drive_time_minutes: z.number().int().positive().max(24 * 60).nullish(),
  terrain: z.enum(['highway', 'mixed', 'offroad', 'urban']).nullish(),
  status: z.enum(['planning', 'research', 'confirmed', 'anchored']).nullish(),
  // … remaining fields
});

export const addLegValidator = (ctx: PennyContext) =>
  addLegInput.refine(
    (d) =>
      d.drive_time_minutes == null ||
      ctx.vehicle?.max_drive_hours_per_day == null ||
      d.drive_time_minutes <= ctx.vehicle.max_drive_hours_per_day * 60,
    {
      message: `drive_time_minutes exceeds vehicle.max_drive_hours_per_day (${ctx.vehicle?.max_drive_hours_per_day}h * 60 = limit). If the route requires more, split into multiple legs.`,
      path: ['drive_time_minutes'],
    }
  );

export const addLegTool: Anthropic.Tool = {
  name: 'add_leg',
  description: 'Add a new driving leg to the trip.',
  input_schema: {
    type: 'object',
    required: ['title'],
    properties: {
      title: { type: 'string' },
      // ... mirror of zod schema but in JSON Schema form
    },
  },
};
```

Yes, that's two definitions of the schema (Zod and JSON Schema). They have different jobs:

- The JSON Schema goes to Claude and shapes what it generates.
- The Zod schema validates what comes back, including cross-field rules JSON Schema can't easily express.

We could derive one from the other (`zod-to-json-schema` package), and probably should once it's stable. For v1 I'd write both by hand — they're not large and the hand-written JSON Schema lets us tune the *descriptions* shown to Claude, which materially affects output quality.

---

## The retry loop

When validation fails, send the error back to Claude and let it correct itself. Pseudocode:

```ts
async function replanWithRetry(ctx, message, images, maxAttempts = 2) {
  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: renderContext(ctx, message, images) },
  ];

  for (let attempt = 0; attempt <= maxAttempts; attempt++) {
    const response = await client.messages.create({
      model: MODEL,
      system: SYSTEM_PROMPT,
      tools: ALL_TOOLS,
      messages,
      max_tokens: 4096,
    });

    const toolUses = response.content.filter(b => b.type === 'tool_use');
    if (toolUses.length === 0) {
      // pure conversational turn — no actions to validate
      return { text: extractText(response), validated: [] };
    }

    const validated: Array<{ id: string; name: string; input: any }> = [];
    const errors: Array<{ id: string; error: string }> = [];

    for (const tu of toolUses) {
      const validator = TOOL_VALIDATORS[tu.name]?.(ctx);
      if (!validator) {
        errors.push({ id: tu.id, error: `unknown tool: ${tu.name}` });
        continue;
      }
      const parsed = validator.safeParse(tu.input);
      if (parsed.success) {
        validated.push({ id: tu.id, name: tu.name, input: parsed.data });
      } else {
        errors.push({ id: tu.id, error: zodErrorToString(parsed.error) });
      }
    }

    if (errors.length === 0) {
      return { text: extractText(response), validated };
    }

    if (attempt === maxAttempts) {
      // out of retries — return what we have plus the failures
      return { text: extractText(response), validated, unrecoverableErrors: errors };
    }

    // Send tool_results back so Claude can correct.
    messages.push({ role: 'assistant', content: response.content });
    messages.push({
      role: 'user',
      content: toolUses.map(tu => {
        const err = errors.find(e => e.id === tu.id);
        return {
          type: 'tool_result' as const,
          tool_use_id: tu.id,
          is_error: !!err,
          content: err ? err.error : 'ok',
        };
      }),
    });
  }
}
```

A few things to note:

- **Cost.** Each retry is another Sonnet call. With max=2, worst case is 3 calls per turn. The existing daily $-cap absorbs this; we should also log retries to `usage_events` so we can see how often it happens.
- **Partial successes.** If Claude emits 5 actions and 1 fails validation, we ship the 4 good ones with `tool_result` for those marked `ok` and `is_error` for the bad one. Claude may re-emit only the bad one or re-emit all five — both are fine because the dispatcher is idempotent on `add_*` (creates) and identifying on `update_*` / `delete_*` (by id). Worth a brief test to confirm Claude doesn't re-emit duplicates of the *succeeded* ones.
- **Hard cap distinct from retry.** If after 2 retries something still fails, surface it to the client as a `failedAction` with the validation error. Don't loop forever.
- **Pure-text turns.** When Claude doesn't emit any tool_use blocks (just a chat reply), we skip validation entirely.

---

## Phased rollout

I'd ship this in three PRs, not one:

**PR 1 — Tool-use plumbing, one action.**

- Add `src/lib/penny/tools/addLeg.ts` with definition + validator.
- Switch `replan()` to send `tools: [addLegTool]` and consume `tool_use` blocks.
- Keep all other actions on the old text-parsed path for now (Claude can use either).
- Wire the retry loop but only for the one action.
- Goal: prove the wiring end-to-end with the smallest surface, on the action that has the actual bug.

**PR 2 — Migrate remaining actions.**

- Add the other 11 tool definitions and validators.
- Drop the regex/`JSON.parse` path entirely.
- Shrink the system prompt: remove `<tool_schema>` and `<output_contract>`; tighten `<leg_planning_rules>` (the soft "Don't exceed it" language can go — the validator enforces it).
- Update `route.ts` dispatcher to consume validated typed inputs.

**PR 3 — Observability & polish.**

- Log retry attempts and validation errors to `usage_events` (new event type `replan_retry`).
- Admin view: which validators are firing most? (Tells us where Claude is consistently confused — a signal to refine the tool description, not the validator.)
- Replace hand-written JSON Schemas with `zod-to-json-schema` if it works cleanly, or keep both if descriptions diverge.

Each PR is independently shippable and reverts cleanly if something breaks in production.

---

## What's NOT in this migration

To keep the scope tight, these are explicitly out:

- **Adding new tools.** `get_route`, `geocode`, etc. live in [`docs/future/penny-tool-surface.md`](../future/penny-tool-surface.md). Once the migration lands, adding a new tool is mechanical.
- **The "is this about travel" classifier.** Discussed in conversation but separate concern. Goes upstream of `replan()`. Belongs in its own proposal.
- **Topic-of-conversation rate limiting.** Same.
- **Live-trip UI** (greyed completed days, current-day primary, horizontal scroll). Different concern, doesn't touch the AI integration.
- **Renaming "leg" → "day"** in the schema. Cosmetic; do it independently.
- **Upgrading Sonnet model.** Currently `claude-sonnet-4-20250514`. Moving to a newer Sonnet might improve tool-use compliance, but that's an orthogonal change with its own evaluation cost.

---

## Open questions for review

1. **Two schema definitions per action (Zod + JSON Schema), or auto-derive?** I'd start with two. Sam: OK?
2. **Retry budget: 2 attempts max?** Pretty conservative. Could go 3 if first-pass fails are common in practice. Easy to tune post-launch.
3. **Where do we put the tool `description` strings?** Each action's `description` field is what Claude reads to understand when to call it — these matter a lot. I'd put them inline in each tool file alongside the schema. Worth a quick review pass with Sam once written; the descriptions are essentially mini-prompts.
4. **Server-side auto-split for over-limit legs as a safety net?** Even with retry, if Claude *insists* on a 21h leg after 2 retries, do we (a) reject and tell the user, or (b) auto-split it server-side at the limit? I lean (a) — auto-split lands the split in arbitrary places. But (b) might be better UX. Worth a call.
5. **Backfill chat history.** `chat_history` rows are stored as Markdown text (`route.ts:317`). Retries shouldn't pollute the user-visible chat with the failed-then-corrected version. Plan: only persist the final response. Confirm.

---

## Resumption checklist (if this gets picked up later, not now)

1. Confirm Anthropic SDK version supports the tool features used here (currently 0.30.0, fine).
2. Re-read `route.ts:107–305` to spot any actions added since this doc was written. Each new action needs a tool definition.
3. Start with PR 1 — `add_leg` only. Get the retry loop working and observe live before fanning out.
4. Add a `usage_events` migration for the new `replan_retry` event type before PR 3.
