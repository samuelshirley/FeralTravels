#!/usr/bin/env bash
# prod-canary-token — sign the production canary in and hand its session to
# GitHub, so .github/workflows/prod-canary.yml can run.
#
# Run it on your Mac (it needs `gh`, signed in to this repo):
#   bash scripts/prod-canary-token.sh
#
# What it does — the ordinary sign-in, nothing bypassed (the /api/test/*
# endpoints are hard-off on production and stay that way):
#   1. Asks production to email a code to samuelashirley+canary@gmail.com
#      (lands in your Gmail), and prompts you for it.
#   2. Verifies it: a normal 30-day session, exactly what the iOS app gets.
#   3. Records AI consent on the account (it is a canary; it has to talk to Penny).
#   4. Stores PROD_CANARY_TOKEN and PROD_CANARY_TOKEN_EXPIRES as repository
#      secrets. The token goes through stdin and is never printed.
#
# If tmp/canary-session.json exists with more than a week left (a session an
# agent minted for you), steps 1–2 are skipped and that file is deleted once the
# secrets are set, so a live token does not sit in the working tree.
#
# The canary alerts five days before the session lapses; re-running this is the
# whole renewal.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
BASE="${CANARY_BASE_URL:-https://www.feraltravels.com}"
EMAIL="samuelashirley+canary@gmail.com"
CACHE="tmp/canary-session.json"
# A worktree under tmp/ has its own tmp/; the agent wrote the cache in the main checkout.
MAIN_CACHE="$(git worktree list --porcelain | awk '/^worktree /{print $2; exit}')/$CACHE"

command -v gh >/dev/null || { echo "Needs the GitHub CLI: brew install gh && gh auth login" >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "gh is not signed in: gh auth login" >&2; exit 1; }

json_field() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s)[process.argv[1]];process.stdout.write(v==null?"":String(typeof v==="object"?JSON.stringify(v):v))})' "$1"; }

token="" expires="" used_cache=""
for f in "$CACHE" "$MAIN_CACHE"; do
  [ -f "$f" ] || continue
  t="$(json_field token < "$f")"; e="$(json_field expires < "$f")"
  if [ -n "$t" ] && node -e 'process.exit(Date.parse(process.argv[1]) - Date.now() > 7*864e5 ? 0 : 1)' "$e"; then
    token="$t"; expires="$e"; used_cache="$f"
    echo "Using the session in $f (expires $expires)."
    break
  fi
done

if [ -z "$token" ]; then
  code_status="$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/api/mobile/otp/send" \
    -H 'content-type: application/json' -d "{\"email\":\"$EMAIL\"}")"
  case "$code_status" in
    200) echo "Code sent to $EMAIL — it is in your Gmail." ;;
    429) echo "A code was sent to $EMAIL in the last minute; use that one." ;;
    *)   echo "Sending the code failed: HTTP $code_status" >&2; exit 1 ;;
  esac
  read -r -p "6-digit code: " code
  resp="$(curl -sS -X POST "$BASE/api/mobile/otp/verify" -H 'content-type: application/json' \
    -d "{\"email\":\"$EMAIL\",\"code\":\"$code\"}")"
  token="$(printf '%s' "$resp" | json_field token)"
  expires="$(printf '%s' "$resp" | json_field expires)"
  [ -n "$token" ] || { echo "Sign-in failed: $(printf '%s' "$resp" | json_field error)" >&2; exit 1; }
fi

consent="$(curl -sS -X PATCH "$BASE/api/me/preferences" -H "authorization: Bearer $token" \
  -H 'content-type: application/json' -d '{"ai_consent":true}' | json_field ai_consent)"
[ "$consent" = "true" ] || { echo "Could not record AI consent on the canary account." >&2; exit 1; }

printf '%s' "$token" | gh secret set PROD_CANARY_TOKEN
printf '%s' "$expires" | gh secret set PROD_CANARY_TOKEN_EXPIRES
echo "Secrets set. The session expires $expires; the canary warns five days before."

[ -n "$used_cache" ] && rm -f "$used_cache" && echo "Removed $used_cache."

read -r -p "Run the canary on GitHub now? [Y/n] " go
if [ "${go:-Y}" != "n" ] && [ "${go:-Y}" != "N" ]; then
  if gh workflow run prod-canary.yml 2>/dev/null; then
    echo "Started — gh run watch \$(gh run list --workflow prod-canary.yml -L1 --json databaseId -q '.[0].databaseId')"
  else
    echo "The workflow is not on the default branch yet — merge the PR first, then: gh workflow run prod-canary.yml"
  fi
fi
