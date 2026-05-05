#!/usr/bin/env bash
# scripts/ship.sh — one-shot "dev → prod" for trip-planner.
#
# What it does (in order):
#   1. tsc --noEmit          → typecheck guard. We refuse to push code that
#                              won't build on Vercel. Five seconds locally
#                              beats a failed deploy on main.
#   2. If the working tree is dirty, stages + commits everything with the
#      message you pass as $1 (default: "dev: ship <timestamp>").
#   3. git push origin HEAD  → triggers a Vercel deploy.
#   4. drizzle-kit push      → syncs schema.ts to the Neon database pointed
#                              at by DATABASE_URL in your local .env.
#   5. drizzle migrate       → advances the migration journal so /drizzle/
#                              SQL files stay an authoritative paper trail
#                              alongside the schema.ts source-of-truth. No-op
#                              if all migrations are already applied.
#   6. backfill-maps-nav     → rewrites any legacy Google Maps path URLs
#                              to dir_action=navigate.
#
# Usage:
#   ./scripts/ship.sh                         # auto-generated commit msg
#   ./scripts/ship.sh "fix chat keyboard bug" # custom commit msg
#   SKIP_TYPECHECK=1 ./scripts/ship.sh        # bypass step 1 (last resort)
#
# Notes:
#   - Since dev and prod currently share a single Neon database, running
#     db:push locally IS running it against prod. That's by design for
#     solo-dev mode; splitting DBs later means running the db:push step
#     with a prod DATABASE_URL instead.
#   - Vercel deploys asynchronously; this script returns as soon as the
#     push is accepted, not when the build finishes.
#   - db:push and db:migrate are deliberately both run. db:push is the
#     authoritative sync (matches schema.ts to the live DB); db:migrate
#     keeps the per-migration journal in step. They converge to the same
#     state for additive changes, but the journal is what a future
#     non-solo-dev workflow will lean on.

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

# ── 2. commit ─────────────────────────────────────────────────────────────
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

# ── 3. push ───────────────────────────────────────────────────────────────
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
step "Pushing ${BRANCH} → origin (Vercel will start building)"
git push origin HEAD

# ── 4. db push ────────────────────────────────────────────────────────────
if [ ! -f .env ]; then
  die ".env not found — can't read DATABASE_URL for db:push"
fi
step "drizzle-kit push (sync schema.ts → Neon)"
npm run --silent db:push

# ── 5. db migrate (journal advance) ───────────────────────────────────────
# Idempotent — drizzle's migrator skips entries already in the journal.
# Failure here is non-fatal because db:push already applied the schema; we
# warn so the journal drift is visible without blocking the deploy.
step "drizzle migrate (advance migration journal)"
npm run --silent db:migrate || warn "db:migrate returned non-zero (schema is already synced via db:push, but the journal may be out of step)"

# ── 6. map-nav backfill ───────────────────────────────────────────────────
step "Rewriting legacy Google Maps URLs to dir_action=navigate"
npm run --silent backfill-maps-nav || warn "backfill-maps-nav returned non-zero (usually harmless if no legacy rows)"

# ── done ──────────────────────────────────────────────────────────────────
printf "\n${GRN}✓ Shipped.${RST} Watch the Vercel deploy at https://vercel.com/dashboard\n"
