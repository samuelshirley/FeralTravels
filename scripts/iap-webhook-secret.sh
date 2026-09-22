#!/usr/bin/env bash
#
# Arm POST /api/webhooks/revenuecat on production, and say WHY it is not armed
# when it isn't.
#
# Why a script rather than a list: the secret has to be byte-identical in two
# systems, and the route compares the header VERBATIM (docs/design/iap-setup.md
# §6 — no parsing, no "Bearer" prefix handling). A value typed twice is a value
# that can differ once.
#
# ── Why this is not a one-liner ─────────────────────────────────────────────
#
# `src/app/api/webhooks/revenuecat/route.ts` has exactly one 503:
# `if (!expected)` on `process.env.REVENUECAT_WEBHOOK_SECRET`. So a 503 from
# production means the variable is falsy IN THE RUNNING DEPLOYMENT — which is
# three different situations that need three different fixes:
#
#   A. not set on Production at all (commonly: set on Preview only)
#   B. set to an EMPTY string — `!expected` is true for "" as well as unset
#   C. set correctly, but the running deployment was built BEFORE it existed.
#      Vercel bakes env vars at build time; adding one changes nothing until
#      the next deploy.
#
# The first version of this script asked `vercel env ls production | grep NAME`,
# which cannot tell A from C — `env ls` prints an Environments column and a
# Preview-only row still contains the name. It reported "already exists on
# production" while production was answering 503. `env pull --environment=production`
# is the question that actually distinguishes them, because it returns VALUES.
#
# Reads production and preview values into a temp file (mode 600, deleted on
# exit) and never prints an existing secret. A newly generated one is printed
# once, because it has to be pasted into RevenueCat.
#
# Usage:  ./scripts/iap-webhook-secret.sh

set -uo pipefail
cd "$(dirname "$0")/.."

BOLD=$'\033[1m'; GRN=$'\033[32m'; RED=$'\033[31m'; YEL=$'\033[33m'; DIM=$'\033[2m'; OFF=$'\033[0m'
VAR=REVENUECAT_WEBHOOK_SECRET
URL=https://www.feraltravels.com/api/webhooks/revenuecat
VC="npx --yes vercel"

# `vercel link` writes project.json for a directory link and repo.json for a
# repo link. This project is repo-linked, so checking only project.json (as the
# first version did) rejects a perfectly linked checkout.
if [ ! -f .vercel/project.json ] && [ ! -f .vercel/repo.json ]; then
  echo "Not linked to a Vercel project. Run: npx vercel link" >&2
  exit 1
fi

TMP=$(mktemp -d)
chmod 700 "$TMP"
trap 'rm -rf "$TMP"' EXIT

probe() {
  curl -s -o /dev/null --max-time 20 -w '%{http_code}' -X POST \
    -H 'Content-Type: application/json' -H 'Authorization: probe-not-the-secret' \
    -d '{"event":{"type":"TEST"}}' "$URL"
}

# Value of $VAR in one environment, or empty string if absent/blank.
value_in() {
  local envname="$1" f="$TMP/$1.env"
  $VC env pull "$f" --environment="$envname" --yes >/dev/null 2>&1 || return 1
  [ -f "$f" ] || return 1
  chmod 600 "$f"
  # Strip the KEY=, then surrounding quotes.
  sed -n "s/^${VAR}=//p" "$f" | head -1 | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//"
}

echo "${BOLD}Where does $VAR actually exist?${OFF}"
PROD=$(value_in production);   PROD_RC=$?
PREV=$(value_in preview);      PREV_RC=$?

if [ "$PROD_RC" -ne 0 ]; then
  echo "${RED}Could not read the production environment.${OFF} Is the CLI logged in? (npx vercel whoami)" >&2
  exit 1
fi

report() { # name, value
  if [ -n "$2" ]; then printf '  %-11s %sset%s (%d chars)\n' "$1" "$GRN" "$OFF" "${#2}"
  else                 printf '  %-11s %snot set or empty%s\n' "$1" "$YEL" "$OFF"; fi
}
report production "$PROD"
[ "$PREV_RC" -eq 0 ] && report preview "$PREV" || echo "  preview     (could not read)"

CODE=$(probe)
echo "  live route  HTTP $CODE"
echo

# Write $1 to $VAR on Production, SHOWING the CLI's own error. The previous
# version sent stderr to /dev/null and reported a bare "failed to set it on
# Vercel", which is the least useful thing a script can say — and it did so
# after generating a secret it never printed.
#
# Three attempts, because the failure mode is unknown rather than diagnosed:
# the documented piped form; the same with a trailing newline (some CLI
# versions read a line rather than a stream); and with an explicit --scope,
# which a repo-linked checkout can need since there is no project.json.
set_on_production() {
  local value="$1" out team

  echo "${DIM}  npx vercel env add $VAR production${OFF}"
  if out=$(printf '%s' "$value" | $VC env add "$VAR" production 2>&1); then
    echo "${GRN}  set on Production${OFF}"; return 0
  fi
  echo "${DIM}  it said:${OFF}"; echo "$out" | sed 's/^/    /'

  echo "${DIM}  retrying with a trailing newline${OFF}"
  if out=$(printf '%s\n' "$value" | $VC env add "$VAR" production 2>&1); then
    echo "${GRN}  set on Production${OFF}"; return 0
  fi
  echo "$out" | sed 's/^/    /'

  team=$(sed -n 's/.*"orgId" *: *"\([^"]*\)".*/\1/p' .vercel/repo.json 2>/dev/null | head -1)
  if [ -n "$team" ]; then
    echo "${DIM}  retrying with --scope $team${OFF}"
    if out=$(printf '%s\n' "$value" | $VC env add "$VAR" production --scope "$team" 2>&1); then
      echo "${GRN}  set on Production${OFF}"; return 0
    fi
    echo "$out" | sed 's/^/    /'
  fi

  return 1
}

# When the CLI will not do it, say exactly where to click. One field in a form
# is not worth blocking the whole item on.
dashboard_fallback() {
  local value="$1"
  echo
  echo "${RED}The CLI would not set it — its own errors are above.${OFF}"
  echo
  echo "${BOLD}Set it in the dashboard instead:${OFF}"
  echo "  Vercel → feral-travels → Settings → Environment Variables → Add New"
  echo "    Key          $VAR"
  if [ -n "$value" ]; then
    echo "    Value        $value"
  else
    echo "    Value        the same string RevenueCat already holds"
  fi
  echo "    Environment  Production only"
  echo
  echo "Or interactively, which prompts instead of piping:"
  echo "  ${BOLD}npx vercel env add $VAR production${OFF}"
  echo
  echo "Then ${BOLD}npx vercel --prod${OFF} and re-run this script."
}

# ── the four cases ─────────────────────────────────────────────────────────
if [ -n "$PROD" ] && [ "$CODE" = "401" ]; then
  echo "${GRN}Already armed.${OFF} The secret is on Production and the live route rejects a wrong one."
  echo "${DIM}Remaining check is RevenueCat's side: Integrations → Webhooks must have an${OFF}"
  echo "${DIM}entry for $URL whose Authorization header is this same string.${OFF}"
  echo
  echo "To rotate deliberately — and update RevenueCat in the same sitting, or every"
  echo "event 401s until you do:"
  echo "  npx vercel env rm $VAR production   # then re-run this script"
  exit 0
fi

if [ -n "$PROD" ] && [ "$CODE" = "503" ]; then
  echo "${YEL}Case C: the variable is on Production but the RUNNING deployment predates it.${OFF}"
  echo "Vercel bakes env vars at build time. Redeploying is the whole fix:"
  echo
  echo "  ${BOLD}npx vercel --prod${OFF}"
  echo
  echo "${DIM}Then re-run this script; it should report 401.${OFF}"
  exit 0
fi

# 401 with nothing read back: the running deployment HAS a secret, we just
# cannot see it (a Sensitive variable is never returned by `env pull`).
# Generating one here would leave RevenueCat and Vercel disagreeing.
if [ -z "$PROD" ] && [ "$CODE" = "401" ]; then
  echo "${GRN}Armed.${OFF} The live route rejects a wrong secret, but the value could not be"
  echo "read back (likely a Sensitive variable). Nothing has been changed."
  exit 0
fi

# Production holds a value but the probe is neither 401 nor 503 (000 = no
# response, 403, 5xx…). Falling through would generate a NEW secret and leave
# RevenueCat holding the old one, so stop and say what came back.
if [ -n "$PROD" ]; then
  echo "${RED}The variable is on Production, but the live route answered HTTP $CODE.${OFF}"
  echo "Nothing has been changed. 401 means armed and 503 means redeploy; anything"
  echo "else is not a secret problem — ./scripts/iap-preflight.sh names the code."
  exit 1
fi

# Production is unset/empty from here on.
if [ -n "$PREV" ]; then
  echo "${YEL}Case A: set on Preview, not on Production.${OFF} That is why the live route 503s"
  echo "and why the first version of this script wrongly said it existed."
  echo
  echo "Copying the PREVIEW value to Production, so that if RevenueCat is already"
  echo "configured with it, RevenueCat needs no change:"
  set_on_production "$PREV" || { dashboard_fallback ""; exit 1; }
else
  echo "${YEL}Not set on Production or Preview.${OFF} Generating one."
  SECRET=$(openssl rand -base64 32)

  # PRINTED BEFORE THE WRITE IS ATTEMPTED, ON PURPOSE. The previous version set
  # it first and printed afterwards, so a failing `env add` destroyed the only
  # copy of a secret that has to be pasted into RevenueCat regardless.
  echo
  echo "${BOLD}The secret — paste it into RevenueCat → your project → Integrations → Webhooks → Add:${OFF}"
  echo
  echo "  URL                     $URL"
  echo "  Authorization header    $SECRET"
  echo "  Environment             Sandbox AND Production (both)"
  echo "  Event types             all of them"
  echo
  echo "${DIM}Raw string, no 'Bearer ' prefix — the route compares it verbatim. Sandbox${OFF}"
  echo "${DIM}events matter: without them, testing proves the sheet works and proves${OFF}"
  echo "${DIM}nothing about granting access.${OFF}"
  echo
  set_on_production "$SECRET" || { dashboard_fallback "$SECRET"; exit 1; }
fi

echo
echo "${BOLD}Now redeploy${OFF} — the change does not reach the running deployment otherwise:"
echo
echo "  ${BOLD}npx vercel --prod${OFF}"
echo
echo "${DIM}Then re-run this script. 401 means armed.${OFF}"
