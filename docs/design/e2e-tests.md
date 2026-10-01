# E2E specs — what each one proves

> Moved out of `CLAUDE.md` on 2026-09-20, verbatim, when that file was cut from
> 225 KB back to a map. Nothing here was rewritten or deleted — only relocated.
> `CLAUDE.md` links here from the one-line summary that replaced it.

### E2E Tests (`e2e/`) — server contracts, since 2026-09-27

legal-pages, web-blocked, oauth-exchange, login-otp, account-deletion, subscriptions, vehicle-crud, fuel-cascade, announcement, breakers

**The screens moved to the phone (2026-09-27).** Sam: iOS is the product, so the end-to-end weight sits on Maestro, and Playwright keeps what does not depend on a screen — the API guards, the legal pages App Review loads, sign-in and real mail delivery, the paywall's server verdicts, the web lock. Every browser spec that drove the locked web front end was rebuilt as a flow on a real simulator (`mobile/maestro/`, run in parallel shards by ci.yml — `docs/design/ios-e2e-bringup.md`), and each Playwright spec was deleted only after its replacement had passed in CI:

| Was (Playwright) | Now |
|---|---|
| `existing-trip` | `trip-itinerary.yaml` — trips list and date header, day cards, drive link, map |
| `lazy-fuel-sourcing` | `trip-itinerary.yaml` (today sources itself; another day only when opened) + `e2e/fuel-cascade.spec.ts` (the server-side dependency cascade, one request) |
| `units-imperial` | `forced-stop-line.yaml` (switched in Settings; mi everywhere, never km) |
| `onboarding-flow`, `onboarding-validation` | `onboarding-wizard.yaml`, `onboarding-range.yaml` (the calendar test was already `onboarding-date-picker.yaml`) |
| `vehicle-crud` (screen half) | `vehicles.yaml`; the last-vehicle API refusal stays in `vehicle-crud` |
| `subscriptions` (screen half) | `paywall.yaml`; every state's verdict and the 402 stay in `subscriptions` |
| `account-deletion` (dialog tests) | `account-deletion.yaml`; the database half stays |
| `announcement` (web modal) | the API the native modal calls, in `announcement` — a seeded announcement is global, so as a Maestro flow it would pop up over the other shards running in parallel |
| `penny-plan-trip`, `chat-maps-link` | `penny-plan-trip.yaml`, `penny-maps-link.yaml` — the `ai` shard, behind the `ai-tests` label, and the most thorough flows in the suite |
| `chat-tab-in-flight` | already `chat-tab-in-flight.yaml` |
| `viewport-hint`, `login-google-button` | nothing — web-only behaviour on a locked front end (decision H8 says so) |

**`account-deletion`** gained a database vantage point in **`POST /api/test/deletion`** (`state` / `seed-usage` / `cleanup-usage`, same three guards as the rest of `/api/test/*`). Without it the suite's strongest claim was `GET /api/trips` → 401, which only proves the SESSION died — an implementation that deleted `sessions` and left every trip, usage row and tombstone in place passed the whole file. It now asserts the tombstone's counts and provider inference, that the ciphertext decrypts back to the address (compared server-side; the plaintext never crosses the wire), that `usage_events` rows SURVIVE with `user_id` detached and `error_message` scrubbed, that the trip rows are gone by user id, and that the address can sign up again into a clean account. Two of those double as config checks and fail loudly rather than skipping: `DELETED_USER_ENC_KEY` must be set on the target environment, as must `AUTH_GOOGLE_IOS_CLIENT_ID` (see `oauth-exchange`).

**`cleanupPlaywright` now requires a fixture address.** Its comment claimed "the endpoint only accepts fixture addresses"; `/api/test/cleanup` validated only `isTestRequestAuthorized` + `z.string().email()`. That gap became real when the function grew a `deleted_users` delete: on a preview — a copy-on-write clone of PROD data — a caller holding the per-run secret could erase the tombstones of a real person who had asked to be forgotten. `deleteUsageByMarker` requires an `e2e-` prefix for the same reason: without it, `{ marker: "anthropic" }` would delete the real billing history.

**`web-blocked`** runs in two projects, `api` against the ordinary preview (`WEB_APP_ENABLED` unset — the web ON, as in production since 2026-10-01) and `web-blocked` against a second deployment with `WEB_APP_ENABLED=0`, and discovers which state it is in by probing an anonymous `/trips` (`/get-the-app` = blocked, i.e. `WEB_APP_ENABLED` is exactly `'0'`; `/login` = open). In both it asserts `/api/*` answers from its own guard, the legal pages and `/login` stay 200, and **`/` is the public landing page** (2026-09-24): 200 with no redirect, the headline ("Roadtrip plan with Penny"), the "Get the app" link with an `https://apps.apple.com/` href, and links to `/privacy`, `/terms`, `/support`. Its `/signin` link is state-aware (2026-10-01): open, a visible **"Try it on the web"** link to `/signin`; blocked, no link to `/signin` at all (no web signup while the web is locked). The four gated paths — `/signin` (the old root), `/trips`, `/settings`, `/vehicle-setup` — must end at `/login` or `/get-the-app` according to the state, never render. `/admin` is asserted apart from them because it does not vary: an anonymous request redirects to `/login?callbackUrl=%2Fadmin` in both states (2026-09-30 — before that the admin, signed out, was sent to the download screen, which has no sign-in).

**`subscriptions`** walks the paywall from outside (see `docs/design/subscriptions.md` §The specs). Its signed-out test (`sub-web-signed-out`) asserts `/` is the landing page — 200, URL stays `/`, "Get the app" visible with an `https://apps.apple.com/` href, no block notice — then that `/signin` and a `/trips` deep link end at `/login` (sign-in form visible) or `/get-the-app`, decided by the same anonymous `/trips` probe as `web-blocked`, restated in a local helper rather than imported.

### Seeded planned trips carry the chat a real trip has (2026-09-28)

Every seeder that leaves a trip with a finished plan — `seedFixture` (`/api/test/seed`), `seedCanonicalTrip` (`/api/test/trip` kind `canonical`) and the admin test-account generator (`seedRealisticAccountData`) — ends with `writeSeededTranscript(tripId)` (`src/server/seededTranscript.ts`). Before, they wrote the vehicle, the trip and its days and no `chat_history`, so a seeded trip opened on Penny's "START HERE" empty state with suggestion chips above a finished itinerary. No real planned trip shows that screen: it always carries the conversation that planned it. Sam's "Ordesa Notes Check" was the report.

The transcript is the one production writes for the cheapest real path — the first trip of a new account whose opening message named the origin, an exact date and a pace: the `trip_intent` Q/A, the scan receipt ("Got it — starting from …, 8 h of driving a day, setting off …"), units, the vehicle's name and range as two Q/A pairs (what the composite card persists), the `handoff` row, `plan_ready`, and Penny's reply with `changes_made` (one `add_leg` per day, through `actionToLegacyChange`) and a `plan_summary` computed from the seeded legs by `computePlanSummary`. Every question is the production constant or builder; every date is derived from the trip's start; there is no AI call, so seeding stays free and deterministic. Seeded trips now carry `daily_drive_hours = 8` (the flat default they were built at), because every real trip has a pace and the opening message names it.

**Left alone, on purpose:** `createAdHocTrip` kinds `onboarding` and `vehicle_new` are parked mid-onboarding — the wizard under test writes their chat — and kind `blank` has no days: it is the "trip with no plan yet" the Penny flows plan from. `scripts/seed-demo-trip.ts` (the public template) is out of scope.

`src/lib/seededTranscriptGuard.test.ts` fails the unit suite when a fixture-gated function writes legs without calling `writeSeededTranscript` after them (decision G10); `src/server/seededTranscript.test.ts` covers the builder.
