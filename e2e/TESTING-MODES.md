# E2E testing modes (users and data)

There are three intentional patterns. They share the same Neon database (solo-dev / CI); naming and cleanup keep them from stepping on each other.

## 1. Stable fixture user + rebuilt seeded trip

**What it is:** One long-lived Auth user (`FIXTURE_EMAIL` in [`fixtures/constants.ts`](fixtures/constants.ts)) whose **all trips and vehicles are removed** at the start of each suite, then one canonical **"E2E Fixture Van"** and **"E2E Fixture Trip"** (two legs) are inserted fresh.

**How it works:** [`global-setup.ts`](global-setup.ts) runs [`scripts/seed-e2e-fixture.ts`](../scripts/seed-e2e-fixture.ts), which upserts the `users` row, deletes every trip and vehicle for that user (cascade cleans legs, chat, …), clears onboarding/remediation-related user fields, then inserts the known fixture van + trip.

**Use when:** You need deterministic data without signing up a new email every run — same identity as “last time,” empty history except the re-seeded trip.

**Concurrency:** Playwright [`playwright.config.ts`](../playwright.config.ts) runs **`workers: 1`**. More workers would execute multiple specs at once against the same fixture rows (races on fleet counts, trips, onboarding). Faster CI needs shard-based splits with separate databases, not extra workers, until suites use isolated users.

**Example:** [`existing-trip.spec.ts`](existing-trip.spec.ts) — asserts the trip card, **default vehicle chip** (name + complete profile), **no remediation overlay**, legs, and map.

---

## 2. Mid-suite throwaway rows (`playwright-*`)

**What it is:** Tests that need an **extra** trip or vehicle during the suite name it `playwright-<runId>-…` via [`playwrightName()`](fixtures/constants.ts).

**How it works:** [`cleanup-e2e.ts`](../scripts/cleanup-e2e.ts) deletes those names at teardown. The next **`globalSetup` still wipes the entire fixture user** anyway, so this is mainly hygiene between rapid re-runs.

Helpers insert **targeted state** before navigation:

| Helper | State |
|--------|--------|
| [`createBlankPlanningTrip`](fixtures/test-trip.ts) | Empty trip, `onboarding_state=done`, optional default vehicle — Penny chat |
| [`createOnboardingTrip`](fixtures/test-trip.ts) | `onboarding_state=not_started` — wizard |
| [`createRemediationPlaywrightTrip`](fixtures/remediation-trip.ts) | Vehicle remediation flag + trip |

**Examples:** [`penny-plan-trip.spec.ts`](penny-plan-trip.spec.ts), [`onboarding-flow.spec.ts`](onboarding-flow.spec.ts), [`vehicle-crud.spec.ts`](vehicle-crud.spec.ts), [`vehicle-remediation.spec.ts`](vehicle-remediation.spec.ts)

---

## 3. Real login / identity flows (optional env)

**What it is:** Exercises the **actual** login UI or external redirect, not the DB session cookie shortcut.

| Mechanism | Config | Spec |
|-----------|--------|------|
| Email OTP | `E2E_OTP_EMAIL` | [`login-otp.spec.ts`](login-otp.spec.ts) |
| Google OAuth entrypoint | None | [`login-google-button.spec.ts`](login-google-button.spec.ts) (URL/assert only) |

**Use when:** You need confidence the **production login path** still works; OTP is skipped unless configured.

[`loginAsFixtureUser`](fixtures/auth.ts) exists because Auth.js database sessions do not play nicely with the test backdoor — see comment in that file.

---

## Adding a fourth pattern: ephemeral Auth users

If a test truly needs a **new `users` row** (e.g. quota per user, empty account with no shared history), add a seed helper that inserts a user + session and extend **cleanup** to delete that user id. Today the suite deliberately avoids that to limit table churn and keep **`npm run e2e:seed`** the single fixture source of truth.
