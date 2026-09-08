#!/usr/bin/env bash
#
# Arm POST /api/webhooks/revenuecat on production.
#
# Generates the shared secret, sets it on Vercel, and prints it ONCE so it can
# be pasted into RevenueCat's Authorization header field. Nothing in here is a
# placeholder and nothing needs editing before it runs.
#
# Why this exists as a script rather than a list: the secret has to be
# byte-identical in two systems, and the route compares the header VERBATIM
# (docs/design/iap-setup.md §6 — no parsing, no "Bearer" prefix handling). A
# value typed twice is a value that can differ once.
#
# Until this is done the route answers 503 to everything, which means a real
# purchase takes the money and grants nothing.
#
# Usage:  ./scripts/iap-webhook-secret.sh

set -euo pipefail
cd "$(dirname "$0")/.."

BOLD=$'\033[1m'; GRN=$'\033[32m'; YEL=$'\033[33m'; DIM=$'\033[2m'; OFF=$'\033[0m'
VAR=REVENUECAT_WEBHOOK_SECRET
URL=https://www.feraltravels.com/api/webhooks/revenuecat

if [ ! -f .vercel/project.json ]; then
  echo "This directory is not linked to a Vercel project. Run: npx vercel link" >&2
  exit 1
fi

echo "${DIM}Checking whether $VAR already exists on production…${OFF}"
if npx --yes vercel env ls production 2>/dev/null | grep -q "$VAR"; then
  echo
  echo "${YEL}$VAR already exists on production.${OFF}"
  echo "Rotating it means updating RevenueCat in the same sitting, or every"
  echo "event 401s until you do. Nothing has been changed."
  echo
  echo "To rotate deliberately:"
  echo "  npx vercel env rm $VAR production   # then re-run this script"
  exit 0
fi

SECRET=$(openssl rand -base64 32)

printf '%s' "$SECRET" | npx --yes vercel env add "$VAR" production >/dev/null
echo "${GRN}Set $VAR on Vercel (production).${OFF}"

echo
echo "${BOLD}Paste this into RevenueCat → your project → Integrations → Webhooks → Add:${OFF}"
echo
echo "  URL                     $URL"
echo "  Authorization header    $SECRET"
echo "  Environment             Sandbox AND Production (both)"
echo "  Event types             all of them"
echo
echo "${DIM}The header value is the raw string above — no 'Bearer ' prefix, because${OFF}"
echo "${DIM}the route compares it verbatim. Sandbox events matter: without them,${OFF}"
echo "${DIM}testing proves the sheet works and proves nothing about granting access.${OFF}"
echo
echo "${BOLD}Then redeploy${OFF} — a running deployment does not pick up a new env var:"
echo "  npx vercel --prod"
echo
echo "${DIM}Afterwards, ./scripts/iap-preflight.sh should report 401 rather than 503.${OFF}"
