# Preview-Gated Deploys (CI-orchestrated)

**Status:** SUPERSEDED — built 2026-07-02, then rebuilt PR-based 2026-08-13 as `.github/workflows/ci.yml` + `deploy-production.yml` + `pr-cleanup.yml` (merging to `main` is the deploy); see CLAUDE.md "Workflow (current)". Kept for design history only. NOTE: every `AUTH_TEST_BACKDOOR*` reference below is obsolete — the auth backdoor was fully removed 2026-07-02. E2E now signs in via the real OTP flow, reading the code for its own fixture address from `/api/test/otp`; `/api/test/*` are behind `E2E_TEST_ENDPOINTS`, hard-off in production. `scripts/ship.sh` is deleted.

**Last updated:** 2026-05-25 (superseded note added 2026-07-02).

---

## Why this is deferred

Today's flow (`scripts/ship.sh`) runs the full Playwright suite locally before pushing to main, then Vercel auto-deploys main to prod. Two problems:

1. **Local network is the test runner's link to everything.** On the plane, Playwright's `next start` on the laptop hits Neon over bad wifi for every DB call, blows the 10s `expect` timeout, and the developer is forced to `SKIP_E2E=1`. This has happened, and it will happen again.
2. **No staged artifact.** Push to main = deploy to prod. If something slipped past local tests, real users (when there are any) hit it.

The plan below moves the test runner off the developer's machine and gates prod on a *tested artifact*, not a tested-on-someone-else's-laptop artifact.

## Why CI-orchestrated and not laptop-orchestrated

We considered two shapes:

- **Shape A — laptop-orchestrated:** `ship.sh` uses Vercel CLI to deploy a preview, runs Playwright locally against that URL, then promotes. Smallest change, but the Playwright runner is still on the developer's laptop firing HTTP at the preview. Plane wifi is still in the loop.
- **Shape B — CI-orchestrated (chosen):** `ship.sh` just pushes to main. GitHub Actions detects the push, waits for Vercel's preview build, runs Playwright on the GH runner, promotes on green. The developer's laptop only needs to push bytes.

Shape B is the plane-proof one. Shape A is a stepping stone we explicitly skipped because it doesn't solve the actual problem.

---

## Architecture findings that shape the design

Two pieces of the codebase made the design simpler than expected:

### `VERCEL_ENV` gates the test backdoor at runtime, not build time

`src/server/auth/test-backdoor.ts:15` returns `false` when `process.env.VERCEL_ENV === 'production'` unless `AUTH_TEST_BACKDOOR_ON_VERCEL_PROD=1` is also set. Vercel sets `VERCEL_ENV` at *runtime* per environment (preview vs production), not baked at build. That means:

- We can build *once* as a preview deployment.
- Run e2e against it (backdoor active because `VERCEL_ENV=preview`).
- `vercel promote` the same deployment to prod. The artifact doesn't change, but `VERCEL_ENV` flips to `production` and the backdoor goes dormant automatically.

This avoids the "build twice" pattern entirely. Tested artifact === served artifact.

### Only one `NEXT_PUBLIC_*` env var, and it's identical across envs

`NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` is the only client-baked env var. Same value in preview and production. No other `NEXT_PUBLIC_*` vars exist in the codebase. So build-once-promote doesn't ship preview-flavoured client JS to prod by accident.

If a new `NEXT_PUBLIC_*` env var is ever added that *should* differ between preview and prod, this plan needs revisiting — the chosen pattern would silently bake the preview value into prod.

---

## Dashboard prerequisites (cannot be done from code)

These have to be set up by a human in the Vercel and GitHub dashboards before the workflow will work.

### Vercel project settings

- **Production Branch:** change from `main` to something that doesn't exist (e.g. `__production_via_ci__`). Reason: this stops Vercel from auto-aliasing prod to every push to main. Pushes to main now produce *preview* deployments only. Prod alias moves only when CI explicitly calls `vercel promote`.

### Vercel env vars (scope matters)

- **Preview only:** `AUTH_TEST_BACKDOOR=1`. The code already guards prod via `VERCEL_ENV`, but scoping here is defence-in-depth.
- **Preview + Production:** `DATABASE_URL`, `ANTHROPIC_API_KEY`, `GOOGLE_MAPS_API_KEY`, `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY`, `RESEND_API_KEY`, `AUTH_SECRET`, `CRON_SECRET`, `AUTH_TEST_BACKDOOR_EMAIL`, and anything else `.env.example` lists. Most of these are already set; verify.

### GitHub repo secrets

The CI workflow needs:

- `VERCEL_TOKEN` — account → settings → tokens
- `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID` — run `vercel link` locally once, then read `.vercel/project.json`
- Everything Playwright needs at runtime: `DATABASE_URL`, `ANTHROPIC_API_KEY`, `GOOGLE_MAPS_API_KEY`, `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY`, `RESEND_API_KEY`, `AUTH_TEST_BACKDOOR_EMAIL`, `E2E_FIXTURE_EMAIL`, plus any others the seed/playwright scripts touch.

---

## Code changes

### `scripts/ship.sh` — slim down

Keep:

- `tsc --noEmit` (typecheck guard)
- `db:push` + `db:migrate` (schema sync to shared Neon **must** happen before preview tests run, because the preview hits the same DB)
- Commit + `git push`

Drop:

- Local `e2e:seed` (moves to CI)
- Local `playwright test` (moves to CI)
- Local `backfill-maps-nav` (moves to CI, runs after promote)

Final message: "Pushed. CI will deploy preview, run e2e, promote on green. Watch GitHub Actions."

The `SKIP_E2E=1` / `SKIP_TYPECHECK=1` escape hatches go away. Don't add a "skip CI" backdoor — see "Things flagged" below.

### New `.github/workflows/deploy.yml`

Trigger: `push: branches: [main]`. Optionally `needs:` the existing `ci.yml` build-test job so unit + build are a fast first gate.

Steps:

1. Checkout, setup node 20, `npm ci`.
2. Wait for Vercel's preview deployment for this commit SHA to be `READY`. Polling options:
   - `vercel ls --token=$VERCEL_TOKEN --meta githubCommitSha=$GITHUB_SHA` and grep for `READY`.
   - Or listen for GitHub's `deployment_status` event (Vercel's GH integration posts these).
   - The CLI poll is more explicit and survives integration outages — preferred.
3. `npm run e2e:seed` against shared Neon (same as today; same blast radius).
4. `E2E_BASE_URL=<preview-url> npm run e2e`.
5. On green: `vercel promote <deployment-id> --token=$VERCEL_TOKEN`. This aliases the prod domain to the tested preview deployment without rebuilding.
6. On green: `npm run backfill-maps-nav` (operates on prod DB; runs once after prod alias swings).
7. On red: exit non-zero. Prod stays on prior deployment.

### Existing `.github/workflows/ci.yml`

Leave as-is (build + unit tests). New deploy workflow can `needs: build-test` so e2e doesn't start if unit/build fails.

---

## Things flagged that should not be buried

- **Polling for the preview URL is the fiddly bit.** Don't trust the GH integration's deployment events as the only signal; back it up with `vercel ls --meta githubCommitSha=$SHA`. If the preview never reaches READY within ~5min, fail the workflow.
- **Penny e2e still calls real Anthropic** (~$0.05–0.20 per ship). Same cost as today, just billed against CI runs. If CI gets re-run a lot mid-development, this adds up.
- **Shared DB risk is unchanged.** Today's seed wipes the fixture user (`feral-e2e-fixture@feraltravels.test`); preview tests still run against shared Neon. The day before first real user, branch Neon and point preview env's `DATABASE_URL` at the branch. That's a separate task — see "Open questions".
- **No skip-CI backdoor.** Resist the urge to add a `[skip ci]` style escape. The reason we're moving here is to *stop* shipping untested code. Emergency hotfix path = Vercel dashboard rollback to last-known-good deployment, not a workflow bypass.

---

## Open questions to resolve when picking this up

1. **Neon branching for preview DB.** Currently planned to defer ("keep shared Neon"). Decide on a trigger to actually do it. First real user is the obvious one. The mechanics: create a Neon branch, set `DATABASE_URL` to the branch URL in Vercel's Preview scope only, point CI's `DATABASE_URL` secret at the same branch. Seed/cleanup scripts should already work unchanged.
2. **Backfill timing.** `backfill-maps-nav` currently runs every ship. Is that still needed, or is it cleanup that can be a one-shot? Worth checking before moving it to CI.
3. **What does "rollback" look like?** Vercel UI supports "Promote to Production" on any prior deployment. Document this as the emergency path so future-you doesn't try to bypass CI.
4. **Should we also tee preview URLs into PR comments?** Not relevant today (no PRs, we work on main), but if we ever switch to a PR workflow, the same `vercel promote` pattern works on PR merges.

---

## Resumption checklist

Do these in order:

1. Read `scripts/ship.sh` and `playwright.config.ts` once to refresh memory. The Playwright config already honours `E2E_BASE_URL` (line 50–54) — most of the wiring is done.
2. In Vercel dashboard, change Production Branch to a non-existent name.
3. Push a throwaway commit to main and confirm Vercel creates a *preview* (not prod) deployment.
4. Add GitHub secrets (Vercel token + ids + runtime env vars).
5. Write `.github/workflows/deploy.yml` per the spec above. Test in isolation first — comment out the `vercel promote` step, just verify steps 1–4 work and you get a green Playwright run against a preview URL.
6. Uncomment the promote step. Test on a low-stakes commit (typo fix in a comment) so you can watch the full flow without risking a real change.
7. Slim down `scripts/ship.sh` per "Code changes" above. Drop the SKIP_E2E env var support — its purpose disappears.
8. Update `CLAUDE.md` Workflow section to reflect the new flow.
9. Decide on Neon branching (open question #1) — even if the answer is "defer again," write it down with a trigger condition.

## Out of scope for this design

- **Staging environment as a separate URL.** Vercel previews already give us per-deployment URLs; a permanent `staging.feraltravels.com` alias adds value once we want to share work-in-progress with non-developers. Not needed now.
- **Replacing Playwright with something else.** The suite works; the problem is *where* it runs, not *what* it is.
- **Per-PR CI.** We work on main; PRs don't exist. Revisit if/when the workflow changes.
