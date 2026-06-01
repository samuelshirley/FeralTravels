# Bug — `addLeg` validator accepts malformed rest legs (no coords, no names)

> **Audience:** A Claude agent picking this up cold. Read `CLAUDE.md` at the repo root first for project orientation, then this document.
>
> **Status:** Diagnosed, not fixed. Verified still present against `main` HEAD `62a4d79` on 2026-06-01.

## Where

- `src/lib/penny/tools/addLeg.ts:25-70` — `baseSchema`. Every field except `title` is `.nullish()`, including `start_name`, `end_name`, `start_lat`, `start_lng`, `end_lat`, `end_lng`.
- `src/lib/penny/tools/addLeg.ts:79-100` — `validator()` `.refine()` only checks drive-time cap on drive legs. No rule covers rest legs.

## What's wrong

On the Summer '26 Trip (`c0c49e75-7349-4eee-a35a-b10a81be25b4`) initial plan build, Penny emitted this rest-leg entry that was accepted by validation:

```json
{"action":"add_leg","data":{"title":"Glacier (rest day)","leg_type":"rest","constraints":[]}}
```

No `start_name`, no `end_name`, no coordinates, no `segment_index`. Just a title and a leg_type. This passes Zod because all those fields are nullish. The consumer (`addLeg` dispatcher) inserts a `legs` row with null coordinates — which then breaks downstream:

- `repairLegContinuity` can't anchor it (no start coords) → likely triggers `penny:continuity-repaired-noroute` (see `docs/bugs/continuity-noroute-surfacing.md`).
- `planFuelStopsForLeg` short-circuits on `leg.startLat == null || leg.startLng == null` and silently sets `fuel_status` to `'none'`.
- The Itinerary UI may render a card with no location info.

## Why it matters

- A rest leg without coordinates is unusable to every downstream consumer. It silently corrupts the plan.
- The Glacier rest-day count on Summer '26 is now wrong: the user's intended 2 nights at Glacier produced 2 valid rest legs + 1 malformed one, so the plan effectively has 3 Glacier "days" — one of which doesn't render meaningfully.
- This is exactly the kind of silent-data-corruption the "no silent failures anywhere in the app" project value cares about.

## Important context — what this is NOT

This was originally mis-filed (by me) as "Penny emits duplicate rest-day add_legs." That was wrong analysis. The system prompt at `src/lib/penny/tools/addLeg.ts:109` explicitly says:

> *"When the user spends one or more nights at a location, emit rest-day legs for each day spent there."*

And the `legs` schema has no `nights` count column. So one rest-day leg per night IS the intended data model — 2 nights at Grand Canyon = 2 rest legs is correct, not buggy.

**The bug is NOT about Penny emitting too many rest legs.** It's specifically about the validator letting through rest legs missing required fields (coords + names).

## Fix shape

Tighten the validator so a rest leg must have coordinates and names:

```ts
return baseSchema
  .refine(
    (d) => {
      if (d.leg_type !== 'rest') return true;
      return d.start_name != null && d.start_lat != null && d.start_lng != null
        && d.end_name != null && d.end_lat != null && d.end_lng != null;
    },
    {
      message: 'rest legs require start_name, end_name, and start/end coordinates (use the same coords for start and end — the rest day is AT a location).',
      path: ['start_name'],
    }
  )
  .refine(/* existing drive-time cap check, unchanged */);
```

Zod-error feedback will go back to Penny via the existing validation-feedback loop in `src/lib/claude.ts`, so she'll see the error and re-emit a corrected call.

### Side question worth resolving while you're in there

Should `segment_index` and `segment_name` also be required on rest legs? The system prompt at `addLeg.ts:115` says rest legs should carry the same segment info as the drive leg that arrives at the destination. Right now both are optional. Recommend making them required-when-the-preceding-drive-has-them, but that's a softer check and can defer.

## Acceptance criteria

- A test in `src/lib/penny/tools/addLeg.test.ts` (create if needed) covering: rest leg with no coords → validation fails with a useful error message.
- A test covering the happy path: rest leg with start/end coords passes.
- Re-running the Summer '26 prompt produces no malformed rest legs. Verify by querying:
  ```sql
  SELECT id, sort_order, leg_type, title, start_name, start_lat, start_lng
  FROM legs
  WHERE trip_id = 'c0c49e75-7349-4eee-a35a-b10a81be25b4' AND leg_type = 'rest'
  ORDER BY sort_order;
  ```
  All rest legs should have non-null coords.
- The existing Summer '26 Trip already has one malformed row — leave it (historic test data). Don't write a cleanup script unless Sam asks.
- `npx tsc --noEmit` + `npm run test` pass.

## State at handoff

- `scripts/debug-trip.ts` is a read-only diagnostic written during the original investigation. **Not yet committed.** Useful for verifying this fix by inspecting the legs table after re-running the prompt.
- Sam's `main` may have uncommitted staged changes from earlier sessions — check `git status` before starting. Per `[[user_multi_agent_git_workflow]]`, resolve or set aside before committing.

## Memories to honor

- **No silent failures anywhere in the app** — this is the principle being violated.
- `[[feedback_penny_capability_honesty]]` — closely related: Penny shouldn't emit data she can't fully populate, and the validator should catch when she does.
- `[[feedback_prefer_simple_deterministic]]` — the fix is a Zod refine rule, deterministic and minimal.
