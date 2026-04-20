#!/usr/bin/env bash
# scripts/ship.sh — one-shot "dev → prod" for trip-planner.
#
# What it does (in order):
#   1. If the working tree is dirty, stages + commits everything with the
#      message you pass as $1 (default: "dev: ship <timestamp>").
#   2. git push origin HEAD  → triggers a Vercel deploy.
#   3. drizzle-kit push      → syncs schema.ts to the Neon database pointed
#                              at by DATABASE_URL in your local .env.
#   4. backfill-maps-nav     → rewrites any legacy Google Maps path URLs
#                              to dir_action=navigate.
#
# Usage:
#   ./scripts/ship.sh                         # auto-generated commit msg
#   ./scripts/ship.sh "fix chat keyboard bug" # custom commit msg
#
# Notes:
#   - Since dev and prod currently share a single Neon database, running
#     db:push locally IS running it against prod. That's by design for
#     solo-dev mode; splitting DBs later means running the db:push step
#     with a prod DATABASE_URL instead.
#   - Vercel deploys asynchronously; this script returns as soon as the
#     push is accepted, not when the build finishes.

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

# ── 1. commit ─────────────────────────────────────────────────────────────
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

# ── 2. push ───────────────────────────────────────────────────────────────
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
step "Pushing ${BRANCH} → origin (Vercel will start building)"
git push origin HEAD

# ── 3. db push ────────────────────────────────────────────────────────────
if [ ! -f .env ]; then
  die ".env not found — can't read DATABASE_URL for db:push"
fi
step "drizzle-kit push (sync schema.ts → Neon)"
npm run --silent db:push

# ── 4. map-nav backfill ───────────────────────────────────────────────────
step "Rewriting legacy Google Maps URLs to dir_action=navigate"
npm run --silent backfill-maps-nav || warn "backfill-maps-nav returned non-zero (usually harmless if no legacy rows)"

# ── done ──────────────────────────────────────────────────────────────────
printf "\n${GRN}✓ Shipped.${RST} Watch the Vercel deploy at https://vercel.com/dashboard\n"
