# Trips work — operating brief

**The task itself is the message Sam pastes when this session starts.** This file
is everything else: where you are, what you may touch, and how this repo works.
If no task has been pasted, ask for it and do nothing until it arrives.

## Where you are

`~/Documents/Github/FeralTravels-trips`, branch `feat/trips-list-ordering`,
forked from `main` after PR #35 merged.

There is a SIBLING checkout of this repo at `~/Documents/Github/FeralTravels` on
another branch. Never cd into it, never run commands there, never check out
another branch here. Two sessions sharing one working tree produced a false
merge-conflict report yesterday; that is why you have your own.

When you check for overlap with other work, diff against `origin/main`, never
against local `main`. A stale local `main` is exactly what produced that false
report.

## Read first

`CLAUDE.md` is 20 KB and is a MAP, not the whole story. PR #35 moved ~205 KB of
it into `docs/design/` — architecture, schema, deploy-pipeline, conventions,
stack, scripts, e2e-tests, penny-tools, mvp-scope, playwright-mcp. Nothing was
deleted. Follow its pointers rather than concluding a topic is undocumented.

## Files you own

    src/server/repos/trips.ts
    src/lib/dates.ts               (+ mobile/shared/lib/dates.ts, src/lib/dates.test.ts)
    src/lib/tripCompletion.ts      (+ mirror)
    src/lib/planStatusLine.ts      (+ mirror)
    src/app/trips/page.tsx
    src/app/trips/TripsList.tsx
    src/app/trips/TripCard.tsx
    src/components/Itinerary.tsx
    src/components/ChatPanel.tsx
    src/server/onboarding.ts
    mobile/app/trips/index.tsx
    mobile/components/TripCard.tsx
    mobile/components/Itinerary.tsx
    mobile/components/TripMap.tsx
    mobile/components/chat/format.ts

Need something outside this list? Stop and ask.

## Shared surfaces — append, never restructure

- `CLAUDE.md` — `claudeMdGuard` forces an entry for any new API route or script.
  Add one line to the right list. Do not reorganise it; it was just rewritten,
  and the size budget is 28 KB against a current 20,373 bytes.
- `docs/decisions.md` — `decisionsRegisterGuard` fails if a new `*Guard.test.ts`
  is not registered. Append at the end of the relevant section, never reorder.
- `mobile/shared/**` — `scripts/sync-shared.mjs` rewrites mirrors wholesale.
  Say so before running it.

## A coupling that will not show up in a diff

`src/components/Itinerary.tsx` and `mobile/components/Itinerary.tsx` render
`LegCard` and pass it `expanded` / `onToggle`. PR #35 fixed a bug where a long
stop name ("Estación de Servicio Repsol in Google Maps") pushed the nav button
off the card — right edge at x=363 against a card ending at x=358 on an iPhone
SE. That fix lives inside LegCard's `expanded && !isRestDay` branch.
`navButtonWrapGuard.test.ts` pins the styles but NOT when the expanded body
mounts. If your work changes collapse behaviour, open a day with a long
fuel-stop name on the simulator and confirm the nav buttons still wrap to two
lines inside the card.

## How this repo works

- **REPRODUCE, NEVER GUESS.** Make the failure happen before naming a cause.
  Never diagnose from a code comment, a commit message, or a plausible theory.
  For web e2e, the Playwright MCP in `.mcp.json` is the FIRST step, not a
  fallback. For anything native, drive the iOS simulator
  (`scripts/ios-e2e-local.sh`, `scripts/pick-ios-simulator.mjs`,
  `mobile/maestro/`). If you cannot reproduce it, say so plainly.
- **Prefer a structural guard that makes a class of bug impossible** over a test
  that merely detects one. Mutation-check every new guard: reintroduce the exact
  bug and watch it fail. State in the PR which mutations you ran and which you
  could not — do not claim a check you did not execute.
- **Reliability is worth the time and the money.** Do not trim coverage, depth or
  fidelity to save CI minutes, API spend or PR wall-clock. If cost is relevant,
  measure it and report the number.
- Production has no real users yet. Never weigh "this would affect N production
  accounts" as a reason to slow down. Prod is still live infrastructure: never
  run tests or seed fixtures against the prod database.

## Gates

`git status --porcelain` empty before you start and after you finish.

Before opening the PR:

    npm run test                      # both vitest projects
    cd mobile && npx tsc --noEmit

**Run `node scripts/sync-shared.mjs` if you touched ANY mirrored file.** There is
no `src/shared/` directory — CLAUDE.md:269 says there is and is wrong. The script
mirrors 32 explicit pairs out of `src/lib/` and `src/types/`, and three of them
are yours:

    src/lib/dates.ts          -> mobile/shared/lib/dates.ts
    src/lib/tripCompletion.ts -> mobile/shared/lib/tripCompletion.ts
    src/lib/planStatusLine.ts -> mobile/shared/lib/planStatusLine.ts

Editing any of those without running sync-shared leaves the mobile mirror stale,
and the mirror ships to devices over the air. Check `scripts/sync-shared.mjs`
for the full list before you decide you are not affected. Say in the PR that you
ran it.

Open a PR into `main`. Do **not** merge it. Report the PR URL and the CI result.

When it is ready to merge, Sam adds the `ai-tests` label — that label triggers
the run the deploy gate reads, so it must be the LAST run before merging. Pushing
after labelling produces a cheap green run that never asked Penny to plan
anything.
