#!/usr/bin/env bash
# scripts/ship.sh — "commit & hand off to CI" for trip-planner.
#
# As of the preview-gated deploy switch, your laptop's only job is to push
# good bytes. Tests + deploy happen on GitHub Actions, NOT here:
#
#   You run `npm run ship`  →  push to main
#   GitHub Actions          →  Vercel builds a preview, Playwright runs against
#                              it, and on green that exact build is promoted to
#                              production. Watch it under the repo's Actions tab.
#
# What this script still does locally (all cheap, all offline-ish):
#   1. tsc --noEmit   → typecheck guard. Refuse to push code that won't build.
#   2. db:push +
#      db:migrate     → sync schema.ts → Neon. CI's Playwright run hits this
#                       same DB against the preview, so the schema must be
#                       current before we push. (Single shared Neon for now;
#                       when we branch the DB, this step targets the prod URL.)
#   3. commit + push  → triggers the GitHub Actions deploy workflow.
#
# What MOVED to CI (.github/workflows/deploy.yml): e2e:seed, the Playwright
# suite, and backfill-maps-nav. The old SKIP_E2E escape hatch is gone on
# purpose — the whole point of this change is to stop shipping untested code.
# Emergency hotfix path is NOT a workflow bypass; it's a Vercel dashboard
# rollback to the last-known-good deployment.
#
# Usage:
#   ./scripts/ship.sh                         # auto-generated commit msg
#   ./scripts/ship.sh "fix chat keyboard bug" # custom commit msg
#   SKIP_TYPECHECK=1 ./scripts/ship.sh        # bypass step 1 (last resort)
#   SKIP_DB_SYNC=1   ./scripts/ship.sh        # skip schema push/migrate
#                                             # (only if DB already matches schema.ts)

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
# Catch TS errors before they hit Vercel. The build there runs the same check;
# doing it locally first keeps broken commits off main and the deploy clean.
if [ "${SKIP_TYPECHECK:-}" = "1" ]; then
  warn "SKIP_TYPECHECK=1 set — skipping typecheck (last-resort use only)"
else
  step "Typechecking (tsc --noEmit)"
  if ! npx --no-install tsc --noEmit --pretty false 2>&1; then
    die "tsc reported errors — fix them, or re-run with SKIP_TYPECHECK=1 if you really mean it"
  fi
fi

# ── 2. db sync ──────────────────────────────────────────────────────────────
# CI's Playwright run hits the same Neon DB against the preview deployment, so
# schema.ts must be synced before we push. db:push applies the schema; db:migrate
# advances the journal so /drizzle/ SQL files stay an authoritative paper trail.
# Both are idempotent.
if [ "${SKIP_DB_SYNC:-}" = "1" ]; then
  warn "SKIP_DB_SYNC=1 — skipping db:push/db:migrate"
elif [ ! -f .env ]; then
  die ".env not found — can't read DATABASE_URL for db:push (CI's e2e needs the schema current)"
else
  step "drizzle-kit push (sync schema.ts → Neon)"
  npm run --silent db:push
  step "drizzle migrate (advance migration journal)"
  npm run --silent db:migrate || warn "db:migrate returned non-zero (schema is synced via db:push, but the journal may be out of step)"
fi

# ── 3. commit ─────────────────────────────────────────────────────────────
MSG="${1:-dev: ship $(date +'%Y-%m-%d %H:%M')}"

if ! git diff-index --quiet HEAD -- || [ -n "$(git ls-files --others --exclude-standard)" ]; then
  step "Staging + committing local changes"
  git add -A
  if git diff --cached --quiet; then
    warn "nothing staged (all changes were gitignored)"
  else
    git commit -m "$MSG"
  fi
else
  printf "${DIM}  working tree clean — skipping commit${RST}\n"
fi

# ── 4. push (hands off to CI) ──────────────────────────────────────────────
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
step "Pushing ${BRANCH} → origin"
git push origin HEAD

# ── done ──────────────────────────────────────────────────────────────────
printf "\n${GRN}✓ Pushed.${RST} CI will build a preview, run E2E against it, and promote on green.\n"
printf "  Watch it: GitHub repo → Actions tab → \"Deploy\" workflow.\n"
