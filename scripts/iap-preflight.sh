#!/usr/bin/env bash
#
# What is actually wired up between this repo, RevenueCat, and production —
# read-only, no side effects, no values to substitute by hand.
#
# Every value below is READ from the repo (mobile/eas.json, constants.ts,
# mobile/storekit/FeralTravels.storekit, mobile/lib/config.ts) or from
# RevenueCat's live API. Nothing here is typed in, so nothing here can drift
# from what the app actually ships.
#
# The three things it answers, in the order they block each other:
#
#   1. Do the product ids agree in all THREE places? A mismatch does not fail
#      loudly — it produces an empty offering, which is the same symptom as an
#      inactive Paid Apps Agreement. See mobile/storekit/README.md.
#   2. Does RevenueCat serve an offering with those ids right now?
#   3. Is the production webhook armed? Per docs/design/iap-setup.md §6 the
#      route answers 503 while REVENUECAT_WEBHOOK_SECRET is unset, and 401 for
#      a wrong secret. 503 means a purchase would take money and grant nothing.
#
# Usage:  ./scripts/iap-preflight.sh

set -uo pipefail
cd "$(dirname "$0")/.."

RED=$'\033[31m'; GRN=$'\033[32m'; YEL=$'\033[33m'; DIM=$'\033[2m'; OFF=$'\033[0m'
ok()   { printf '%s  ok  %s%s\n' "$GRN" "$1" "$OFF"; }
bad()  { printf '%s FAIL %s%s\n' "$RED" "$1" "$OFF"; FAILED=1; }
warn() { printf '%s note %s%s\n' "$YEL" "$1" "$OFF"; }
FAILED=0

EAS=mobile/eas.json
STOREKIT=mobile/storekit/FeralTravels.storekit
CONSTANTS=src/server/payments/constants.ts
CONFIG=mobile/lib/config.ts

# ── 1. product ids, three sources ──────────────────────────────────────────
echo "── product ids ────────────────────────────────────────────────────────"

ids_constants=$(grep -oE "id: '[^']+'" "$CONSTANTS" | sed "s/id: '//;s/'//" | sort)
ids_storekit=$(jq -r '.subscriptionGroups[].subscriptions[].productID' "$STOREKIT" | sort)

printf '%sconstants.ts%s  %s\n' "$DIM" "$OFF" "$(echo "$ids_constants" | tr '\n' ' ')"
printf '%s.storekit   %s  %s\n' "$DIM" "$OFF" "$(echo "$ids_storekit" | tr '\n' ' ')"

if [ "$ids_constants" = "$ids_storekit" ]; then
  ok "constants.ts and the StoreKit config file agree"
else
  bad "constants.ts and $STOREKIT disagree — the local sheet will render empty"
  diff <(echo "$ids_constants") <(echo "$ids_storekit") | sed 's/^/     /'
fi

# ── 2. RevenueCat, live ────────────────────────────────────────────────────
echo
echo "── revenuecat (live) ──────────────────────────────────────────────────"

KEY=$(jq -r '.build.production.env.EXPO_PUBLIC_REVENUECAT_IOS_KEY // empty' "$EAS")
KEY_PREVIEW=$(jq -r '.build.preview.env.EXPO_PUBLIC_REVENUECAT_IOS_KEY // empty' "$EAS")

if [ -z "$KEY" ]; then
  bad "no EXPO_PUBLIC_REVENUECAT_IOS_KEY in $EAS build.production.env"
elif [[ "$KEY" != appl_* ]]; then
  bad "the production key does not start with appl_ — mobile/lib/config.ts will treat it as UNSET"
else
  ok "production key present (${KEY:0:9}…)"
  [ "$KEY" = "$KEY_PREVIEW" ] || warn "preview and production carry DIFFERENT keys — deliberate?"
fi

if [ -n "$KEY" ]; then
  RESP=$(curl -s --max-time 20 \
    -H "Authorization: Bearer $KEY" -H "X-Platform: ios" \
    "https://api.revenuecat.com/v1/subscribers/iap-preflight-probe/offerings")

  if [ -z "$RESP" ] || ! echo "$RESP" | jq -e . >/dev/null 2>&1; then
    bad "RevenueCat did not answer with JSON"
  else
    CURRENT=$(echo "$RESP" | jq -r '.current_offering_id // "null"')
    ids_rc=$(echo "$RESP" | jq -r --arg c "$CURRENT" \
      '.offerings[] | select(.identifier==$c) | .packages[].platform_product_identifier' | sort)

    printf '%scurrent      %s  %s%s%s\n' "$DIM" "$OFF" "$CURRENT" "  " ""
    printf '%srevenuecat  %s  %s\n' "$DIM" "$OFF" "$(echo "$ids_rc" | tr '\n' ' ')"

    if [ "$CURRENT" = "null" ]; then
      bad "no current offering — getStorePlans() returns [] and the sheet shows mode: unavailable / store_empty"
    elif [ "$ids_rc" = "$ids_constants" ]; then
      ok "RevenueCat's current offering matches constants.ts exactly"
    else
      bad "RevenueCat's offering does not match constants.ts — mode: unavailable / no_match"
      diff <(echo "$ids_constants") <(echo "$ids_rc") | sed 's/^/     /'
    fi
  fi
fi

ENT=$(grep -oE 'REVENUECAT_ENTITLEMENT_ID *= *"[^"]+"' "$CONFIG" | sed 's/.*"\(.*\)"/\1/')
warn "entitlement id is \"$ENT\" — NOT checkable from any public API."
printf '     %sRevenueCat → Entitlements → \"%s\" must exist with BOTH products attached.%s\n' "$DIM" "$ENT" "$OFF"
printf '     %sIf it is missing, purchases succeed, entitlements.active[\"%s\"] stays empty,%s\n' "$DIM" "$ENT" "$OFF"
printf '     %sand restore() reports nothing_to_restore forever.%s\n' "$DIM" "$OFF"

# ── 3. the webhook ─────────────────────────────────────────────────────────
echo
echo "── production webhook ─────────────────────────────────────────────────"

URL=https://www.feraltravels.com/api/webhooks/revenuecat
CODE=$(curl -s -o /dev/null --max-time 20 -w '%{http_code}' -X POST \
  -H 'Content-Type: application/json' -H 'Authorization: iap-preflight-not-the-secret' \
  -d '{"event":{"type":"TEST"}}' "$URL")

case "$CODE" in
  503) bad "503 — REVENUECAT_WEBHOOK_SECRET is UNSET on production."
       printf '     %sA real purchase would take the money and grant nothing.%s\n' "$DIM" "$OFF"
       printf '     %sFix: ./scripts/iap-webhook-secret.sh%s\n' "$DIM" "$OFF" ;;
  401|403) ok "$CODE — the secret is set and a wrong one is rejected" ;;
  200) bad "200 for a WRONG Authorization header — the route is default-open" ;;
  000) bad "no response from $URL" ;;
  *)   warn "unexpected $CODE from $URL" ;;
esac

echo
[ "$FAILED" -eq 0 ] && printf '%sall automated checks passed%s\n' "$GRN" "$OFF" \
                    || printf '%ssomething above blocks a working purchase%s\n' "$RED" "$OFF"
exit "$FAILED"
