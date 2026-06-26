# E2E testing modes (users and data)

There are several intentional patterns. They share the same Neon database (solo-dev / CI); naming and cleanup keep them from stepping on each other.

## 1. Seeded personas (stable emails, rebuilt graphs)

**What it is:** Long-lived Auth users recreated each suite at known emails — **primary planner** (`FIXTURE_EMAIL`) with a complete default van + `"E2E Fixture Trip"`, and **remediation persona** (`REMEDIATION_FIXTURE_EMAIL`) with an incomplete van + `"E2E Remediation Trip"`. Separate users so remediation specs never contend with playwright throwaway trips on the planner account.

**How it works:** [`global-setup.ts`](global-setup.ts) runs [`scripts/seed-e2e-fixture.ts`](../scripts/seed-e2e-fixture.ts), which upserts each `users` row, deletes **that user’s** trips and vehicles only, then inserts the canonical vehicle + trip for that persona.

**Use when:** You need deterministic rows without asserting numeric primary keys — look up by **trip/vehicle names** or use regex URL assertions; personas isolate cross-spec interference.

**Concurrency:** Playwright [`playwright.config.ts`](../playwright.config.ts) runs **`workers: 1`**. More workers would execute multiple specs at once against the same fixture rows (races on fleet counts, trips, onboarding). Faster CI needs shard-based splits with separate databases, not extra workers, until suites use isolated users.

**Example:** [`existing-trip.spec.ts`](existing-trip.spec.ts) — asserts the trip card, **default vehicle chip** (name + complete profile), **no remediation overlay**, legs, and map.

---

## 2. Mid-suite throwaway rows (`playwright-*`)

**What it is:** Tests that need an **extra** trip or vehicle during the suite name it `playwright-<runId>-…` via [`playwrightName()`](fixtures/constants.ts).

**How it works:** [`cleanup-e2e.ts`](../scripts/cleanup-e2e.ts) deletes those names at teardown. The next **`globalSetup` still rebuilds seeded personas** anyway, so this is mainly hygiene between rapid re-runs.

Helpers insert **targeted state** before navigation:

| Helper | State |
|--------|--------|
| [`createBlankPlanningTrip`](fixtures/test-trip.ts) | Empty trip, `onboarding_state=done`, optional default vehicle — Penny chat |
| [`createOnboardingTrip`](fixtures/test-trip.ts) | `onboarding_state=not_started` — wizard |

**Examples:** [`penny-plan-trip.spec.ts`](penny-plan-trip.spec.ts), [`onboarding-flow.spec.ts`](onboarding-flow.spec.ts), [`vehicle-crud.spec.ts`](vehicle-crud.spec.ts)

---

## 3. Real login / identity flows (optional env)

**What it is:** Exercises the **actual** login UI or external redirect, not the DB session cookie shortcut.

| Mechanism | Config | Spec |
|-----------|--------|------|
| Email OTP | `E2E_OTP_EMAIL` | [`login-otp.spec.ts`](login-otp.spec.ts) |
| Google OAuth entrypoint | None | [`login-google-button.spec.ts`](login-google-button.spec.ts) (URL/assert only) |

**Use when:** You need confidence the **production login path** still works; OTP is skipped unless configured.

[`loginAsFixtureUser`](fixtures/auth.ts) / [`loginAsE2eUser`](fixtures/auth.ts) exist because Auth.js database sessions do not play nicely with the test backdoor — see comment in that file.

---

## Adding a fourth pattern: ephemeral Auth users

If a test truly needs a **new `users` row** (e.g. quota per user, empty account with no shared history), add a seed helper that inserts a user + session and extend **cleanup** to delete that user id. Today the suite deliberately avoids that to limit table churn and keep **`npm run e2e:seed`** the single fixture source of truth.
