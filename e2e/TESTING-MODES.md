# E2E testing modes (users and data)

There are TWO mail paths (one cheap, one real) and two data patterns. Locally the suite runs
against your dev database via the Playwright webServer; in CI it runs against
the tested Vercel preview on the rolling `preview` Neon branch (never prod).

## 1. Identity: a fresh fixture user per test (real OTP sign-in)

**What it is:** every authenticated test mints a unique fixture address and
signs in through the REAL login flow — submit the address on `/login`, read
the code the app just generated, type it on `/login/verify`. There is **no
auth bypass**: no session-minting endpoint, no test provider, nothing
(`src/lib/noBackdoorGuard.test.ts` enforces this at the unit level). What is
skipped is the mailbox, not a step of authentication — the code is generated,
stored with its real expiry, and checked by the real `verifyOtpCode`.

**How:** [`createFreshUser()`](fixtures/auth.ts) → inbox;
[`loginViaOtp(page, user, { redirectTo })`](fixtures/auth.ts) → the UI dance.
Needs nothing external: the code is read from the guarded `/api/test/otp`
endpoint, which is 404 unless `E2E_TEST_ENDPOINTS=1` (never on production),
requires the per-run secret in CI, and refuses any address outside the
`playwright-*@e2e.feraltravels.com` pattern — a subdomain with no MX, so a
fixture address can never be a real person's. Those addresses also skip the
Resend transport entirely (`isFixtureRecipient` in `auth/otp.ts`): the
subdomain would hard-bounce, and a dozen bounces per run against the domain
real sign-in mail comes from is how a sending reputation dies.

**Why per-test:** total isolation. No cross-spec state, no shared account
races, deterministic counts ("exactly two vehicle cards") even on CI retries.
Costs nothing external and ~2s per test.

## 1b. The one spec that uses a REAL mailbox

**What it is:** [`login-otp.spec.ts`](login-otp.spec.ts) signs in at an address
on a Resend **receiving** domain (`playwright-<tag>@$E2E_INBOX_DOMAIN`), waits
for the message to actually arrive, and asserts the delivered subject and both
body parts carry the code before typing it in. It is the only thing in the repo
that proves the app can send a sign-in email at all.

**Why it's separate:** mode 1 is fast and free but blind to delivery; this one
is the eyes. Keeping it to a single spec is what makes a mail dependency safe —
a mail problem reds ONE spec instead of switching the pipeline off, which is
exactly what happened when the whole suite hung off a disposable-inbox vendor
in August.

**Setup:** `E2E_INBOX_DOMAIN` + a Resend key (`RESEND_API_KEY`, or
`AUTH_RESEND_KEY` which it falls back to). Add a receiving domain in the Resend
dashboard first — the managed `<id>.resend.app` needs no DNS. Unset → this spec
skips and `E2E_MAX_SKIPPED=1` tolerates exactly that one skip. **Set the
secrets, then drop that allowance to 0.** A *wrong* credential fails loudly
rather than skipping — see [fixtures/mailbox.ts](fixtures/mailbox.ts), which
also documents honestly what a Resend→Resend round-trip does not prove.

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

[`login-otp.spec.ts`](login-otp.spec.ts) is the real-delivery test — see 1b
above. [`login-google-button.spec.ts`](login-google-button.spec.ts) asserts the
OAuth URL only — Google blocks headless completion.

## Concurrency

`workers: 1` in [`playwright.config.ts`](../playwright.config.ts). Per-test
users remove the shared-identity races, so raising this is now plausible —
but verify specs don't contend on globals (announcements are global; the
announcement spec parks/restores them) before turning it up.
