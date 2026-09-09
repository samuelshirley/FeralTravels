# Decisions — what the app does, why, and what stops it going backwards

**DRAFT for review, 2026-09-09.** Built from the current CLAUDE.md and the code, with every
"Enforced by" checked against a test file that exists in the tree at `357726d`. One line of
context each; the long stories live in git (`git log -S "<phrase>"`).

Format: **Decision** (present tense) — why — *Enforced by:* `test` | **NOT ENFORCED** (prose only).
A decision without a guard survives only as long as someone reads this file at the right moment.

**Why this file exists — the case that proves it:** CLAUDE.md said in ten places that Finn finds
fuel on OSM Overpass + OSRM "for free". Commit `a0c9ee6` (2026-07-22) moved it to Google Places +
Directions (paid) and CLAUDE.md was never updated. Seven weeks later an assistant relayed the
stale claim as fact, designed a fuel cascade on the belief the calls were free, and wrote the
false rationale back into CLAUDE.md. Nothing could have caught it except a reader who happened
to check — which is what "NOT ENFORCED" means.

---

## A. Product scope

A1. **v1.0 is: plan the route → find fuel along it. Nothing else ships until that works.**
Two stop types only: `fuel` (Finn, automatic) and `other` (user-added via link/address/name).
*Enforced by:* `lib/penny/tools/addStop.test.ts` (Penny can only author `other`). The `StopType`
union itself — **NOT ENFORCED**.

A2. **Removed and not coming back:** dump stations, travel style, vehicle remediation, stop
photos, the overnight/food/rest stop finders, nightly replan, trip lifecycle
(`draft/active/completed`), proactive emails, cron. Rebuilding any of them "helpfully" is a
regression. *Enforced by:* `removedFeaturesGuard.test.ts` — comments are stripped before scanning, so a tombstone comment is fine and live code is not — `noExternalCallsGuard.test.ts` blocks the photos
endpoint only.

A3. **Production has no real users until the owner says "launched", in words.** Never weigh "N
accounts affected" as a reason to slow down. Prod is still live infrastructure: no tests or
fixtures against it. *Enforced by:* policy (`test-endpoints.test.ts` enforces the second half).

## B. Penny (the chat agent)

B1. **Penny is the conductor, not the search engine.** Finn finds fuel; Penny only triggers it
(`plan_fuel_stops`) and never writes a `fuel` stop. *Enforced by:* `addStop.test.ts`.

B2. **Penny never authors coordinates.** `resolve_place` (Google Places Text Search) is the only
name→lat/lng path. *Enforced by:* **NOT ENFORCED** — prompt rule only; no validator checks where
an `add_leg` coordinate came from.

B3. **The fuel range is written in onboarding and Settings only, never from chat.** A range
statement in chat is a fuel REQUEST (→ Finn) or a declared tank state (`declare_fuel_state`), not
a preference edit. *Enforced by:* `updateVehicle.test.ts` (range not in the tool schema),
`declareFuelState.test.ts`.

B4. **Penny never redefines a rest leg's location or metrics** — the schedule rebuild would
silently revert it while her prose claims success. *Enforced by:* `updateLeg.test.ts`.

B5. **Penny runs on Haiku 4.5; changing the model is a deliberate, tested act** (every token
type bills 3× on Sonnet; measured 2026-09-09: same plan $0.585 → $0.085). *Enforced by:*
`lib/models.test.ts`.

B6. **Every turn records `toolTrace` (tool names per model call) in `penny_turns.result_meta`.**
The number of model calls is the cost; without the trace a 37-call turn is invisible.
*Enforced by:* `toolTraceGuard.test.ts`.

B7. **The "plan is ready" message is deterministic, written by the server, only when something
was actually saved.** Penny does not recite the plan back. *Enforced by:* `planReady.test.ts`.

B8. **Plan numbers (days, dates, totals, ETA) come from `planSummary`, never from Penny's
prose; Penny never states prices.** *Enforced by:* `planSummary.test.ts` for the numbers;
the "prose never states them" half — **NOT ENFORCED**.

B9. **Tool-call markup never reaches the user.** Leaked `<invoke>` text is bounced once, then
stripped. *Enforced by:* `sanitize.test.ts`.

B10. **`delete_leg` is blocked only when it creates a NEW >50 km gap relative to the trip's
current gaps** (comparing against zero made every delete impossible once one gap existed).
*Enforced by:* `contiguityGate.test.ts`.

B11. **`add_leg` without explicit placement goes after the last leg whose end is within 50 km of
the new start.** *Enforced by:* `legPlacement.test.ts`.

B12. **If the deterministic pipeline overrides an edit Penny already described, the user is
told** (`overriddenEdits`), and it is logged. *Enforced by:* `editOverride.test.ts`.

B13. **One running turn per trip, DB-enforced; every send carries an idempotency key; queued
turns drain in-request.** *Enforced by:* partial unique index `penny_turns_one_running_per_trip_idx`
(structural, migration 0019) + `applyOutcome.test.ts` for the client heal path. No unit test on
the promotion race — `pennyTurns.test.ts` — the partial unique index in the schema AND the 23505→null catch that turns "someone else won" into "stay queued"; both halves are load-bearing beyond the index.

B14. **Penny does not author derived fields: split-point names, drive-leg titles, `end_date`.**
(Pending — section 3 of `docs/tasks/2026-09-09-haiku-fuel-tankwalk.md`.) Haiku wrote "Texas
Panhandle" and titled a Marfa leg "Austin → Big Bend". *Enforced by:* **NOT YET**.

B15. **Ambiguous "go here" + a place → ONE clarifying question before any edit.** *Enforced by:*
**NOT ENFORCED** (prompt).

## C. Finn (fuel) — data sources and math

C1. **Finn's data is Google: Directions for geometry, Places (New) Text Search along-route for
stations. There is no OSM, OSRM, or fuel-price layer.** (`a0c9ee6`, 2026-07-22.) Both are paid
SKUs. *Enforced by:* `removedFeaturesGuard.test.ts` (no live OSM/OSRM reference anywhere in src/ or mobile/) + `googleAccountingGuard.test.ts`. It contradicted CLAUDE.md for seven weeks, and /privacy told users their fuel data went to OpenStreetMap for the same seven weeks — both fixed 2026-09-09 — and CLAUDE.md contradicted it for seven weeks.

C2. **Every Google call is accounted in `usage_events`.** *Enforced by:* `googleAccountingGuard.test.ts` — was FALSE until 2026-09-09 (eleven call sites, no logging since 2026-06-29). `src/server/google/accounted.ts` is now the only way server code calls a paid Google API, logging the failure path too, and the guard forbids importing the raw clients anywhere else: `logGooglePlacesUsage` has had no caller since 2026-06-29. Fix pending in the
fuel brief.

C3. **Fuel is sourced lazily when a day is opened, cached 48 h, invalidated per affected leg —
never a trip-wide fan-out.** *Enforced by:* `fuelCache.test.ts`, `LegCard.fuelResource.test.tsx`,
`e2e/lazy-fuel-sourcing.spec.ts`.

C4. **Before planning day N, every unsourced drive leg since the last real refuel is sourced
first (the dependency cascade).** A never-opened day is indistinguishable from "needed no fuel"
to the tank walk; without this, opening day 12 first reported −1896 km of range. *Enforced by:*
`finn/sourcingOrder.test.ts`, `plan.test.ts`, `e2e/lazy-fuel-sourcing.spec.ts`.

C5. **A remaining range ≤ 0 at a leg's start is `tank_state_invalid` (retryable, logged),
never `no_stations_found`.** The sentence "next fuel N km ahead — beyond safe range (−M km)" is
unrepresentable. *Enforced by:* `finn/plan.test.ts`.

C6. **Only a real fuel stop or the trip start refills the tank; rest days and overnights do
not.** *Enforced by:* `penny/fuelTankState.test.ts`.

C7. **One range number per vehicle (`range_km`, 200–1500), the never-exceed ceiling.** Stop
logic is "don't run dry before the next reachable station", not "every N km"; a forced stop
carries a one-line reason. *Enforced by:* `vehicleProfile.test.ts`, `finn/range.test.ts`,
`finn/plan.test.ts` (reason string).

C8. **Truck-only / private stations are filtered out.** *Enforced by:* `finn/stationFilter.test.ts`.

C9. **A day that needs no stop reads as a quiet positive state on both platforms, never as the
"no stations" warning.** *Enforced by:* `fuelEmptyStateGuard.test.ts`, `StopsSection.test.tsx`.

C10. **A same-place leg (< 0.1 km) is `ready` with zero stops before any external call.**
*Enforced by:* `googleAccountingGuard.test.ts` — the trivial-leg short-circuit must PRECEDE both external calls, asserted on position rather than presence by a named test — verify in `plan.test.ts`.

## D. Auth and accounts

D1. **There is no session bypass, anywhere.** E2E signs in through the real OTP flow and reads
its own fixture's code from a guarded endpoint that grants nothing. *Enforced by:*
`noBackdoorGuard.test.ts`, `test-endpoints.test.ts`, `e2e/login-otp.spec.ts`.

D2. **A database failure is a 503, never a sign-out.** The `auth()` wrapper tells "no cookie"
from "cookie but store unreachable"; `rawAuth` is for `/login` pages only. *Enforced by:*
`signOutOnFailureGuard.test.ts`, `sessionStore.test.ts`.

D3. **Account deletion is in-app, immediate, unrecoverable, one transaction, cascades from
`users.id`, and explicitly clears email-keyed rows and free text in `usage_events`.** The only
trace is an HMAC tombstone. *Enforced by:* `accountDeletion.test.ts`, `deletedUserCrypto.test.ts`,
`e2e/account-deletion.spec.ts`.

D4. **Both sign-in paths (Auth.js events AND `createSessionForEmail`) call the same per-sign-in
hooks** (comped flag, admin flag, promo auto-claim). Wiring only the events has broken native
sign-in before. *Enforced by:* `signInHooksGuard.test.ts`.

D5. **Native OAuth exchange refuses forged, replayed, expired, wrong-audience and wrong-issuer
tokens, and a refusal never carries a session.** *Enforced by:* `oauthIdentity.test.ts`,
`oauthReplay.test.ts`, `e2e/oauth-exchange.spec.ts`.

D6. **Avatar is photo or glyph, never initials; every avatar URL is sanitised in and out.**
*Enforced by:* `avatarUrl.test.ts`, `AppNavbar.test.tsx`.

D7. **Every error code an API can return has copy in every client that calls it.**
*Enforced by:* `nativeErrorCopyGuard.test.ts`.

D8. **OTP resend is throttled, and timestamps are `timestamptz`** (a `timestamp` column made the
cooldown negative off-UTC). *Enforced by:* `otpThrottle.test.ts`; the column rule — `schemaTimestamptzGuard.test.ts` (it found the 44th column: `user_viewport_time.updated_at`, converted in the DB by 0032 but left bare in schema.ts).

## E. Payments

E1. **`src/server/payments/` is a bounded module; `hasEntitlement(userId)` is the only question
anyone else asks.** *Enforced by:* `paymentsBoundaryGuard.test.ts` (no import guard) — `paywallCopy.test.ts`
already imports `payments/states` from outside the module.

E2. **Twelve account states, pure, with the clock passed in.** Cancelling keeps access to period
end; the trial ends on age OR $1 of spend; comped skips the cap but still logs. *Enforced by:*
`payments/states.test.ts`, `paywallSpendGuard.test.ts`, `types/entitlement.test.ts`.

E3. **The RevenueCat webhook is the only grant path; `TRANSFER` follows the Apple ID** (the
losing account is expired silently). *Enforced by:* `payments/webhook.test.ts`.

E4. **The paywall master switch is a DB row (`app_meta.paywall_enabled`), fails closed to OFF,
and every flip is logged with who pressed it.** *Enforced by:* `payments/switch.test.ts`.

E5. **Promo codes: bound to one address, single-use via an atomic claim, fixed 6/12-month term
from REDEMPTION, auto-claimed on sign-in, never clobber a live Apple subscription.**
*Enforced by:* `promoCode.test.ts`, `promoTerm.test.ts`, `promoCopy.test.ts`.

E6. **A fake purchase exists only for `sam+trial-<tag>@feraltravels.com` with
`SUBSCRIPTION_TESTING=1`; the admin test-user block never mints a session.** *Enforced by:*
`testPurchase.test.ts`, `testAccounts.test.ts`, `noBackdoorGuard.test.ts`.

E7. **The purchase sheet is reachable in every account state** (Settings → Plan → View plans) —
App Review signs in as a trial user and must be able to find a price. *Enforced by:*
**NOT ENFORCED** — `purchaseMode.test.ts` covers the sheet's modes, not its reachability.

E8. **`/privacy`, `/terms`, `/support` are anonymous.** *Enforced by:* `paywallPaths.test.ts`,
`e2e/legal-pages.spec.ts`.

## F. Build, CI, deploy

F1. **Merging a PR IS the deploy. The deploy job refuses unless CI for that PR's head SHA is
green; a direct push to `main` lands but never deploys.** *Enforced by:* the workflow itself.
**Branch protection is OFF** — GitHub enforces nothing; the `gh api` block to turn it on is in
CLAUDE.md. *Decision still open: turn it on?*

F2. **No E2E spec may skip (`E2E_MAX_SKIPPED=0`); the two Anthropic-spending specs run only on
the `ai-tests` label; the production key never reaches the runner.** *Enforced by:*
`aiSpecGate.test.ts`, `scripts/assert-e2e-ran.mjs`.

F3. **Two Anthropic keys: `ANTHROPIC_API_KEY_CI` wins on every runtime except production.**
*Enforced by:* `anthropicKey.test.ts`. That the CI key is actually SET in Vercel Preview —
`scripts/check-preview-env.mjs`, which runs in CI and now requires `ANTHROPIC_API_KEY_CI`. Its absence is SILENT rather than a crash — `anthropicKey()` falls through to the production key and every preview turn bills it, which is exactly what happened until 2026-09-09 (it wasn't, 2026-09-08–09; `scripts/vercel-set-ci-key.sh`).

F4. **OTA vs native build is decided by `decide-mobile-release.mjs`, fails safe to native, and
the native build is gated.** *Enforced by:* `decideMobileRelease.test.ts`.

F5. **`src/` never imports from `mobile/`; shared files are byte-identical mirrors.**
*Enforced by:* `noMobileImportGuard.test.ts`, `sharedMirror.test.ts`.

F6. **Vercel's git auto-deploy is off; GitHub Actions owns every deployment.** *Enforced by:*
`vercel.json` (config) — `vercelConfigGuard.test.ts` by test.

F7. **Previews serve a copy-on-write clone of PROD data on a public URL** (accepted; branch dies
with the PR; `noindex`). *Enforced by:* **NOT ENFORCED**. *Decision worth re-asking before launch.*

F8. **The migration chain cannot replay from an empty database; a fresh DB is `db:push` +
`seed-migration-journal.ts`.** *Enforced by:* **NOT ENFORCED** (documented only).

## G. Data and API contracts

G1. **Every API route accepts exactly one Zod shape; free-text interpretation lives only at the
boundary that owns it (onboarding).** *Enforced by:* `routeValidationGuard.test.ts` — every route reading a JSON body must Zod-parse it; a multipart upload (the one legitimate variant) must still validate each field through a named validator; and `PATCH /api/trips/[id]` must not import the LLM date parser generically.

G2. **All DB access goes through `src/server/repos/*`; no raw SQL in routes.** *Enforced by:*
**NOT ENFORCED** — a grep-style guard would be ~20 lines.

G3. **An LLM converts, it never authors: forced tool schema in, server re-validation out.**
*Enforced by:* `parseStartDate.test.ts`, `onboardingIntentScan.test.ts` (per call site).

G4. **Migrations are additive (add → backfill → switch → drop later).** *Enforced by:* `migrationShapeGuard.test.ts` — newest migration additive unless its filename says `drop`, and every .sql must be journaled (it found three that never were).

G5. **All timestamps are `timestamptz`** (migration 0032 converted 43 columns). *Enforced by:*
`schemaTimestamptzGuard.test.ts` — a schema-text guard would catch a new `timestamp()` column.

G6. **"Today" is the driver's wall clock (`users.timezone`), never the server's.**
*Enforced by:* `dates.test.ts`.

G7. **A trip is "completed" by derivation from its last leg date, never a stored status.**
*Enforced by:* `tripCompletion.test.ts`.

G8. **Trip cloning copies every column it should** — a new column must be added to the clone.
*Enforced by:* `cloneTripColumns.test.ts`.

## H. UI conventions

H1. **Copy rule: every string tells the user something they cannot already see.**
*Enforced by:* **NOT ENFORCED** (review discipline).

H2. **An imperial user sees miles and never km.** *Enforced by:* `noHardcodedUnitsGuard.test.ts`,
`e2e/units-imperial.spec.ts`.

H3. **Every "go here" link is a drive from the device (`buildGoHereUrl`), not a pin.**
*Enforced by:* `goHereLinksGuard.test.ts`, `StopsSection.test.tsx`.

H4. **A server module never CALLS an export of a `'use client'` module.** *Enforced by:*
`serverClientBoundaryGuard.test.ts` (mutation-checked against `...buttonStyle()`).

H5. **Exactly one Google Maps key (`NEXT_PUBLIC_GOOGLE_MAPS_API_KEY`) for browser and server;
geocoding is Places (New) `searchText` only.** *Enforced by:* `oneGoogleKeyGuard.test.ts` — past assistants
repeatedly proposed a server key.

H6. **All client geolocation goes through `DeviceLocationContext`.** *Enforced by:* `geolocationGuard.test.ts`.

H7. **The native `KeyboardAvoidingView` lives at the screen root; `ChatPanel` never adds
`insets.bottom`.** *Enforced by:* `mobile/maestro/chat-keyboard.yaml` (real simulator; the tap on
send is the gate, not `assertVisible`).

H8. **The viewport hint cookie makes a phone's reload render the phone tree first.**
*Enforced by:* `e2e/viewport-hint.spec.ts`.

H9. **Never silently swallow errors** — inline UI or `ErrorNotifier`. *Enforced by:* **NOT ENFORCED** — measured 2026-09-09: 41 empty catches outside test files, the large majority deliberate fire-and-forget telemetry (`logUsageEvent(...).catch(() => {})`), a pattern this repo endorses. Enforcing it needs a `// swallow-ok: <reason>` marker on all 41 with an accurate per-site reason: an editorial pass, not a guard. One shipped with a 41-entry baseline would be decoration.

H10. **The onboarding form's vocabulary (kinds, tap-to-answer list, labels, collapse rule) has
one definition, shared by web and native.** *Enforced by:* `onboardingForm.test.ts`,
`onboardingProgress.test.ts`, `ChatPanel.answeredStep.test.tsx`.

H11. **The planning clip resumes on foreground on both platforms.** *Enforced by:*
`planningClipResumeGuard.test.ts`, `PennyPlanningLoader.test.tsx` (to be retargeted).

H12. **`PrivacyInfo.xcprivacy` is authored in `app.config.js` with exactly the reason codes read
off the real manifests; `DDA9.1`/`8FFB.1` are absent on purpose.** *Enforced by:*
`privacyManifest.test.ts`.

H13. **The iOS bundle id is `com.feraltravels.ios` everywhere (token audience, Maestro, product
ids, StoreKit file); Android stays `com.feraltravels.app`.** *Enforced by:* `bundleIdGuard.test.ts`
(`git grep com.feraltravels.app` should return only Android).

H14. **Delete-account emphasis: the phrase is semibold, the disarmed button carries no danger
colour.** *Enforced by:* `DeleteAccountSection.test.tsx`, `deleteAccountEmphasisGuard.test.ts`.


## Machine-checked meta (added 2026-09-09)

Not product decisions — the checks that keep this register and CLAUDE.md from
becoming the next false document.

M1. **Every test this register names exists, and every `src/lib/*Guard.test.ts`
is named here.** A register pointing at a renamed test is the same failure as
CLAUDE.md describing a data source replaced seven weeks earlier: the reader
believes something is checked when nothing is. *Enforced by:*
`decisionsRegisterGuard.test.ts`.

M2. **CLAUDE.md's index lists are complete and name nothing deleted.** Fourteen
scripts were missing when this was written. A tombstone ("`ship.sh` is GONE") is
allowed and valuable; a mention that reads as though the file still exists is
not. *Enforced by:* `claudeMdGuard.test.ts`.

M3. **CLAUDE.md is under 20 KB.** *Enforced by:* `claudeMdGuard.test.ts` —
**currently `it.skip`**, with a dated reason: the file is ~200 KB and shrinking it
is an editorial pass, not something a test can do. The limit was deliberately NOT
raised to match the file, because a limit moved to whatever the file weighs today
is a guard switched off while still showing green. A separate assertion fails if
the file grows by half again, so the skip cannot be forgotten silently.

M4. **The prose half is REVIEWED by a model, never authored by one.**
`.github/workflows/docs-drift.yml` asks Claude to list the sentences in CLAUDE.md
and this register that a PR's diff makes false, and to post one review comment.
It does not edit files: an action that rewrites CLAUDE.md on merge is the same
failure as the OSM claim — a model authoring a document nobody reviews.
