# Task: enforce the NOT ENFORCED decisions in docs/decisions.md, and keep CLAUDE.md honest by machine

Read CLAUDE.md, then `docs/decisions.md` (the register — 74 decisions, 29 marked NOT ENFORCED).
The register is the spec for this task. Rules: every guard is MUTATION-CHECKED (reintroduce the
exact violation, watch it red, restore) before it is committed; a guard that never went red is
decoration. Guards are source-text or schema-text tests under `src/lib/` in the repo's existing
style (`goHereLinksGuard.test.ts`, `serverClientBoundaryGuard.test.ts`, `noBackdoorGuard.test.ts`
are the models). Run `npx tsc --noEmit && npm run test` after each. One commit per group.

## Why

On 2026-07-22 Finn moved from OSM/OSRM to Google Places + Directions (`a0c9ee6`). CLAUDE.md kept
saying OSM/OSRM "for free" in ten places for seven weeks; an assistant relayed it as fact, built
a fuel cascade on that belief, and wrote the false rationale back into CLAUDE.md. Prose cannot
defend itself. Each guard below turns one decision into something the suite refuses to let regress.

## 1. Guards — code and schema (one test file each unless noted)

| # | Decision | Guard | Mutation check |
|---|---|---|---|
| A2 | Removed features stay removed | `removedFeaturesGuard.test.ts`: fail if `src/`/`mobile/` contain `dump_station`, `travel_style`, `travelStyle`, `remediation`, `StopPhoto`, `nightly`, `overnight` (as a StopType), `replenishFuelStopsForTrip`, `fuelPricing`, `overpass`, `osrm` (case-insensitive; allowlist test files and this guard) | add `const x = 'dump_station'` to a src file |
| B2 | Penny never authors coordinates | in the replan dispatcher: every `add_leg`/`update_leg`/`add_stop` lat/lng must match (±11 m) a coordinate returned THIS TURN by `resolve_place`, `get_route` (incl. split points) or an existing leg/stop; otherwise reject with an instructive validation error. Unit test on the pure matcher + `tools/addLeg.test.ts` case | pass a coordinate not in the turn's results |
| B6 | `toolTrace` on every turn | `toolTraceGuard.test.ts`: `claude.ts` pushes to `toolTrace` in the loop and the `done` event carries it; `route.ts` writes `toolTrace` and `modelCalls` into the applied payload | delete the push |
| B8 | Penny's prose never states plan numbers | out of scope for a guard (needs an LLM judge) — leave NOT ENFORCED, say so in the register |
| B13 | one running turn per trip | `pennyTurns.test.ts`: `promoteTurnToRunning` maps `23505` to null; schema text contains the partial unique index | remove the catch |
| B14 | derived fields (split names, titles, end_date) | delivered by the fuel/Haiku brief §3; add to its guard list, not here |
| B15 | ambiguous "go here" asks first | prompt-only — leave NOT ENFORCED |
| C1 | Finn is Google, paid | covered by A2's `overpass`/`osrm` forbid + `noExternalCallsGuard` allowlist naming exactly `places.googleapis.com` and `maps.googleapis.com` as Finn's hosts | add an `overpass-api.de` fetch |
| C2 | every Google call is accounted | `googleAccountingGuard.test.ts`: `places.ts` and `google/directions.ts` call `logGooglePlacesUsage` / a `logGoogleDirectionsUsage` (add it) on every code path incl. error; plus an e2e assertion in `lazy-fuel-sourcing.spec.ts` that opening a never-sourced day writes ≥1 `google-*` usage row (via `/api/test/deletion`-style vantage or a new `/api/test/usage`) | remove the call |
| C10 | trivial leg short-circuits before any external call | `plan.test.ts` / `server/fuel.ts` unit: 0.05 km leg → `ready`, fetch mock never invoked | remove the short-circuit |
| D4 | both sign-in paths call the same hooks | `signInHooksGuard.test.ts`: `auth/index.ts` events AND `createSessionForEmail` in `auth/otp.ts` each call `syncCompedFlagOnSignIn`, `syncAdminFlagOnSignIn`, `claimPromoOnSignIn`; one list of hook names, both call sites checked | delete one call |
| D8 | no `timestamp` without tz | `timestamptzGuard.test.ts`: `schema.ts` contains no `timestamp(` without `withTimezone: true` | add one |
| E1 | `payments/` is bounded | `paymentsBoundaryGuard.test.ts`: nothing outside `src/server/payments/` imports `payments/states`, `payments/entitlements`, `payments/constants`, or the `subscriptions` table; fix `paywallCopy.test.ts` (import via `payments/index`) | add an import |
| E7 | purchase sheet reachable in every state | `e2e/subscriptions.spec.ts`: for a comped fixture and a trial fixture, Settings → Plan → "View plans" renders two prices | hide the button when entitled |
| F3 | CI key is set where it must be | `scripts/check-preview-env.mjs` (already runs in CI) asserts `ANTHROPIC_API_KEY_CI` is present in the preview env; fail the preview job otherwise | unset it |
| F6 | Vercel git deploy off | `vercelConfigGuard.test.ts`: `vercel.json` has `git.deploymentEnabled: false` for every branch | flip it |
| F8 | migration chain | leave NOT ENFORCED (documented); optional: a CI job that runs `db:migrate` against an EMPTY postgres and is allowed to fail with a known message — owner's call |
| G1 | one Zod shape per route | `routeSchemaGuard.test.ts`: every `src/app/api/**/route.ts` that reads a body calls `.parse`/`.safeParse` on a Zod schema before any repo call (source-text heuristic; allowlist the webhook's raw-body signature path) | remove a parse |
| G2 | no raw SQL outside repos | `noRawSqlGuard.test.ts`: `sql\`` and `db.execute(` appear only under `src/server/repos/`, `src/server/db/`, `scripts/`, tests | add one to a route |
| G4 | additive migrations | `migrationShapeGuard.test.ts`: the NEWEST migration file contains no `DROP COLUMN`/`DROP TABLE` unless its filename contains `drop` (so a drop is deliberate and greppable) | rename |
| G5 | timestamptz | same as D8 |
| H5 | one Google key | `oneGoogleKeyGuard.test.ts`: `GOOGLE_MAPS_SERVER_API_KEY` appears nowhere in `src/`, `mobile/`, `.env.example`; every Google host fetch reads `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` | add the env var |
| H6 | GPS only via `DeviceLocationContext` | `geolocationGuard.test.ts`: `navigator.geolocation` / `expo-location` appear only in the two context files | call it elsewhere |
| H9 | never silently swallow | `emptyCatchGuard.test.ts`: no `catch {}` / `catch (e) {}` / `.catch(() => {})` with an empty body in `src/`, `mobile/` (allowlist with a `// swallow-ok: <reason>` marker) | add one |
| H13 | bundle id | `bundleIdGuard.test.ts`: `com.feraltravels.app` appears only in the Android config; `com.feraltravels.ios` in `app.config.js`, `oauthIdentity.ts` default, `ci.yml`, `ios-e2e-local.sh`, `constants.ts`, the `.storekit` file | change one |
| — | CLAUDE.md size | `claudeMdGuard.test.ts`: `CLAUDE.md` ≤ 20 KB (after the cleanup PR lands; until then skip with a dated reason, not a raised limit) | append 20 KB |
| — | CLAUDE.md index lists are complete | same file: every `scripts/*` (except `lib/`) and every `src/app/api/**/route.ts` path is mentioned in CLAUDE.md, and every script/route CLAUDE.md mentions exists | add a script, don't list it |
| — | register ↔ tests | `decisionsRegisterGuard.test.ts`: every `Enforced by:` test path in `docs/decisions.md` exists; every `src/lib/*Guard.test.ts` is named somewhere in the register | rename a test |

## 2. Not guards — actions and decisions for the owner (do NOT do these silently)

- **F1 branch protection is OFF.** Run the `gh api` block from CLAUDE.md ONLY if the owner says
  so in the PR thread; if he does, update the two CLAUDE.md paragraphs that describe it as off.
- **F7 previews serve a clone of prod data on a public URL.** Post the options in the PR body
  (Vercel Pro deployment protection for previews only; or seed previews from a fixture DB
  instead of a prod clone) with the cost of each; the owner decides.
- **THE PAYWALL SWITCH IS OFF IN PRODUCTION (measured 2026-09-09: no `paywall_enabled` row in
  `app_meta`).** `applySwitch` therefore reports every account entitled: the $1 trial ceiling and
  the $8.50 soft block enforce NOTHING today; the only live spend gates are the route-level
  120 req/h and $5/day per user (admins exempt). Do not flip it in this task. Put it in the PR
  body in bold and in `docs/design/launch-checklist.md` as a launch step.
- **A3, H1** are policy/review, not guards. Mark them so in the register.

## 3. Keep CLAUDE.md honest on every PR — reviewer, not author

Add `.github/workflows/docs-drift.yml` on `pull_request`, using Anthropic's official
`anthropics/claude-code-action` with `ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY_CI }}`
(never the production key) and a fixed prompt: *"Read the PR diff, CLAUDE.md and
docs/decisions.md. List every sentence in those two files the diff makes false, stale, or
incomplete (a new route/script/tool/table not listed, a removed one still listed, a changed
behaviour still described the old way). Post ONE review comment with the exact lines and the
replacement text. Do not edit files. If nothing is stale, post nothing."* Rationale, which goes
in the workflow header: an action that REWRITES CLAUDE.md on merge is the same failure as the OSM
claim — an LLM authoring a document nobody reviews — while a review comment lands where a human
already is, in the PR, before merge; the deterministic half (index completeness, size cap,
register ↔ tests) is the guard tests above and needs no model at all. Cost is one call per PR
push against the diff + ~35 KB of docs — measure it in the Console after three PRs and record
the number in the workflow header. Skip the job when the diff touches only `docs/` or `*.md`.

## 4. Validate, PR

`npx tsc --noEmit && npm run test` green; every guard's mutation check recorded in the commit
body ("red on: …"); update `docs/decisions.md` so no line says NOT ENFORCED that now has a test,
and CLAUDE.md's Testing section lists the new guards in one line each. `gh pr create`, title
"test: enforce the register — 20 guards, and a docs-drift reviewer".
