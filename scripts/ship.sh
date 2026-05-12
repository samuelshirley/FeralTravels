#!/usr/bin/env bash
# scripts/ship.sh — one-shot "dev → prod" for trip-planner.
#
# What it does (in order):
#   1. tsc --noEmit          → typecheck guard. We refuse to push code that
#                              won't build on Vercel. Five seconds locally
#                              beats a failed deploy on main.
#   1b. drizzle-kit push +
#       drizzle migrate     → (when .env exists) sync schema + migrations to
#                              DATABASE_URL *before* E2E. The fixture seed and
#                              app expect columns to match schema.ts — running
#                              Playwright first against a stale Neon would
#                              fail (e.g. nullable units_pref).
#   2. E2E fixture seed +
#      playwright test      → `npm run e2e:seed` (planner + remediation personas),
#                              then full Playwright suite (`next start`).
#                              Global-setup re-runs the seed (idempotent).
#   3. If the working tree is dirty, stages + commits everything with the
#      message you pass as $1 (default: "dev: ship <timestamp>").
#   4. git push origin HEAD  → triggers a Vercel deploy.
#   5. drizzle-kit push      → syncs schema.ts to the Neon database pointed
#                              at by DATABASE_URL in your local .env.
#   6. drizzle migrate       → advances the migration journal so /drizzle/
#                              SQL files stay an authoritative paper trail
#                              alongside the schema.ts source-of-truth. No-op
#                              if all migrations are already applied.
#   7. backfill-maps-nav     → rewrites any legacy Google Maps path URLs
#                              to dir_action=navigate.
#
# Usage:
#   ./scripts/ship.sh                         # auto-generated commit msg
#   ./scripts/ship.sh "fix chat keyboard bug" # custom commit msg
#   SKIP_TYPECHECK=1 ./scripts/ship.sh        # bypass step 1 (last resort)
#   SKIP_E2E=1 ./scripts/ship.sh              # bypass step 2 (last resort —
#                                             # use only when you've manually
#                                             # confirmed the change is safe,
#                                             # e.g. docs-only edits)
#   SKIP_DB_SYNC=1 ./scripts/ship.sh          # skip schema push/migrate before
#                                             # E2E (only if DB already matches
#                                             # schema.ts; seed may fail otherwise)
#
# Notes:
#   - Since dev and prod currently share a single Neon database, running
#     db:push locally IS running it against prod. That's by design for
#     solo-dev mode; splitting DBs later means running the db:push step
#     with a prod DATABASE_URL instead.
#   - The E2E suite runs against Neon; `npm run ship` invokes `npm run e2e:seed`
#     before Playwright so both seeded personas exist in the log explicitly.
#     Playwright global-setup runs the seed again idempotently. `playwright-*`
#     rows created mid-suite are scrubbed at teardown.
#   - The Penny submit-trip E2E test calls Anthropic for real, costing
#     ~$0.05–0.20 per ship. Set SKIP_E2E=1 if you're shipping at high
#     velocity and have other coverage in place.
#   - **Tests before push:** if Playwright fails, this script exits and never
#     runs `git push`, so Vercel never gets the commit. Bypass only with SKIP_E2E=1.
#   - Vercel deploy starts after a successful push; the script exits before push
#     when CI steps fail above.
#   - db:push and db:migrate run before E2E (step 1b) and again after push
#     (steps 5–6); both pairs are idempotent.

set -euo pipefail

cd "$(dirname "$0")/.."

RED=$'\033[31m'
GRN=$'\033[32m'
YLW=$'\033[33m'
DIM=$'\033[2m'
RST=$'\033[0m'

step() { printf "\n${GRN}→ %s${RST}\n" "$*"; }
warn() { printf "${YLW}! %s${RST}\n" "$*"; }
die()  { printf "${RED}✗ %s${RST}\n" "$*" >&2; exit 1; }

# ── 1. typecheck ──────────────────────────────────────────────────────────
# Catch TS errors before they hit Vercel. The build there will run the same
# check anyway — doing it locally first avoids polluting `main` with broken
# commits and keeps the deploy log clean.
if [ "${SKIP_TYPECHECK:-}" = "1" ]; then
  warn "SKIP_TYPECHECK=1 set — skipping typecheck (last-resort use only)"
else
  step "Typechecking (tsc --noEmit)"
  if ! npx --no-install tsc --noEmit --pretty false 2>&1; then
    die "tsc reported errors — fix them, or re-run with SKIP_TYPECHECK=1 if you really mean it"
  fi
fi

# ── 1b. db sync before E2E ──────────────────────────────────────────────────
# Seed + server code assume schema.ts matches Neon. E2E runs before the
# post-push db steps below, so we push/migrate here first when possible.
if [ "${SKIP_DB_SYNC:-}" = "1" ]; then
  warn "SKIP_DB_SYNC=1 — skipping db:push/db:migrate before E2E"
elif [ ! -f .env ]; then
  warn ".env not found — cannot db:push before E2E (ensure DATABASE_URL matches Playwright)"
else
  step "drizzle-kit push (sync schema → Neon before E2E)"
  npm run --silent db:push
  step "drizzle migrate (journal before E2E)"
  npm run --silent db:migrate || warn "db:migrate returned non-zero before E2E"
fi

# ── 2. e2e seed + playwright ───────────────────────────────────────────────
# Full suite: deterministic planner persona + remediation persona (see scripts/
# seed-e2e-fixture.ts). Seed runs once here so `ship` always shows that step,
# then again in Playwright global-setup (idempotent wipe + rebuild).
if [ "${SKIP_E2E:-}" = "1" ]; then
  warn "SKIP_E2E=1 set — skipping E2E suite (last-resort use only)"
else
  step "E2E fixture seed (planner + remediation personas)"
  if [ ! -f .env ]; then
    die ".env missing — cannot run e2e:seed (needs DATABASE_URL)"
  fi
  npm run --silent e2e:seed || die "e2e:seed failed — fix DATABASE_URL / schema and retry"

  step "Running Playwright E2E suite"
  # Ensure browser binaries exist (cheap no-op when already installed,
  # but saves a confusing "Executable doesn't exist" wall-of-errors
  # after a Playwright version bump or fresh checkout).
  npx --no-install playwright install chromium 2>/dev/null || true
  if ! npx --no-install playwright test 2>&1; then
    die "Playwright reported failures — open the HTML report (npm run e2e:report) or re-run with SKIP_E2E=1 if you really mean it"
  fi
fi

# ── 3. commit ─────────────────────────────────────────────────────────────
MSG="${1:-dev: ship $(date +'%Y-%m-%d %H:%M')}"

if ! git diff-index --quiet HEAD -- || [ -n "$(git ls-files --others --exclude-standard)" ]; then
  step "Staging + committing local changes"
  git add -A
  # --allow-empty-message false by default; if nothing was actually staged
  # (e.g. only ignored files appeared), the commit will be skipped.
  if git diff --cached --quiet; then
    warn "nothing staged (all changes were gitignored)"
  else
    git commit -m "$MSG"
  fi
else
  printf "${DIM}  working tree clean — skipping commit${RST}\n"
fi

# ── 4. push ───────────────────────────────────────────────────────────────
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
step "Pushing ${BRANCH} → origin (Vercel will start building)"
git push origin HEAD

# ── 5. db push ────────────────────────────────────────────────────────────
if [ ! -f .env ]; then
  die ".env not found — can't read DATABASE_URL for db:push"
fi
step "drizzle-kit push (sync schema.ts → Neon)"
npm run --silent db:push

# ── 6. db migrate (journal advance) ───────────────────────────────────────
# Idempotent — drizzle's migrator skips entries already in the journal.
# Failure here is non-fatal because db:push already applied the schema; we
# warn so the journal drift is visible without blocking the deploy.
step "drizzle migrate (advance migration journal)"
npm run --silent db:migrate || warn "db:migrate returned non-zero (schema is already synced via db:push, but the journal may be out of step)"

# ── 7. map-nav backfill ───────────────────────────────────────────────────
step "Rewriting legacy Google Maps URLs to dir_action=navigate"
npm run --silent backfill-maps-nav || warn "backfill-maps-nav returned non-zero (usually harmless if no legacy rows)"

# ── done ──────────────────────────────────────────────────────────────────
printf "\n${GRN}✓ Shipped.${RST} Watch the Vercel deploy at https://vercel.com/dashboard\n"
