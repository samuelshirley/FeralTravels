# E2E testing modes (users and data)

There is ONE identity model and two data patterns. Locally the suite runs
against your dev database via the Playwright webServer; in CI it runs against
the tested Vercel preview on the rolling `preview` Neon branch (never prod).

## 1. Identity: a fresh fixture user per test (real OTP sign-in)

**What it is:** every authenticated test mints a unique fixture address
and signs in through the REAL login flow — submit the address on `/login`,
read the actual OTP email the app sends via Resend, type the code on
`/login/verify`. There is **no auth bypass**: no session-minting endpoint, no
test provider, nothing (`src/lib/noBackdoorGuard.test.ts` enforces this at the
unit level).

**How:** [`createFreshUser()`](fixtures/auth.ts) → inbox;
[`loginViaOtp(page, user, { redirectTo })`](fixtures/auth.ts) → the UI dance.
Needs nothing external: the code is read from the guarded `/api/test/otp`
endpoint, which is 404 unless `E2E_TEST_ENDPOINTS=1` (never on production) and
refuses any address outside the `playwright-*@e2e.feraltravels.com` pattern.
(uptime shouldn't red the pipeline — but watch for mass-skips before promoting).

**Why per-test:** total isolation. No cross-spec state, no shared account
races, deterministic counts ("exactly two vehicle cards") even on CI retries.
Costs ~1 inbox + 1 Resend send + ~5–10s per test; documented fallback if quota
bites: one fresh user per RUN in global-setup with shared `storageState`.

## 2. Seeded canonical graph (per fresh user)

**What it is:** the classic fixture — default van (`E2E Fixture Van`) +
`E2E Fixture Trip` with two legs (Paris→Strasbourg→Stuttgart) — seeded for the
test's own fresh user via [`seedCanonicalFixture(email)`](fixtures/test-trip.ts)
over the guarded `/api/test/seed` endpoint (fixture DATA only; hard-off on
Vercel production; per-run secret in CI).

**Use when:** the test needs an existing trip/vehicle to look at. Look rows up
by name (`FIXTURE_TRIP_NAME` / `FIXTURE_VEHICLE_NAME` in
[constants.ts](fixtures/constants.ts)).

## 3. Mid-suite throwaway rows (`playwright-*`)

**What it is:** targeted extra state named `playwright-<runId>-…` via
[`playwrightName()`](fixtures/constants.ts), created over `/api/test/trip`:

| Helper | State |
|--------|--------|
| [`createBlankPlanningTrip`](fixtures/test-trip.ts) | Empty trip, `onboarding_state=done`, default vehicle — Penny chat |
| [`createOnboardingTrip`](fixtures/test-trip.ts) | `onboarding_state=not_started` — wizard |
| [`createVehicleNewProfileTrip`](fixtures/test-trip.ts) | `onboarding_state=vehicle_new`, incomplete vehicle — validation |

Specs that create these clean up via
[`cleanupPlaywrightFixtureData(email)`](fixtures/test-trip.ts); since users are
disposable, leftovers are inert anyway (CI's DB branch is re-cloned each push).

## Login-flow specs

[`login-otp.spec.ts`](login-otp.spec.ts) is the focused test of the OTP
round-trip itself (same flow the auth fixture uses).
[`login-google-button.spec.ts`](login-google-button.spec.ts) asserts the OAuth
URL only — Google blocks headless completion.

## Concurrency

`workers: 1` in [`playwright.config.ts`](../playwright.config.ts). Per-test
users remove the shared-identity races, so raising this is now plausible —
but verify specs don't contend on globals (announcements are global; the
announcement spec parks/restores them) before turning it up.
