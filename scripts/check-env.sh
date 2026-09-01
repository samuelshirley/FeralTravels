#!/usr/bin/env bash
#
# Refuse to start `next dev` with a required env var that resolves to EMPTY,
# and name the file that emptied it.
#
# ── Why the message names a file ───────────────────────────────────────────
#
# "ANTHROPIC_API_KEY is empty" sends you to `.env`, where it is fine, and you
# lose an afternoon. The value came from `.env.local` — which `vercel env pull`
# writes with every key present and empty, and which Next loads AHEAD of `.env`.
# Naming the file, and naming the correct value it is shadowing, is the entire
# difference between a useful error and a misleading one.
#
# ── Why a boot-time guard and not an API change ────────────────────────────
#
# `/api/trip/replan` already answers a polite 503 when ANTHROPIC_API_KEY is
# missing, and that is CORRECT for a user in production — a civil message, not
# a stack trace. The defect was never the response. It was that nothing failed
# at startup, so a local server ran answering 503 to every send while an iOS
# e2e flow reported green over the top of it. This fails at the one moment when
# being loud is free.
#
# Wired as `predev`, so `npm run dev` cannot start without it.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
# ONE implementation of the resolution order, shared with the iOS e2e loop.
# shellcheck source=scripts/lib/env-value.sh
. scripts/lib/env-value.sh

# FATAL: the app can do nothing meaningful without these, and the failures they
# produce are indirect enough to cost real time. An empty DATABASE_URL is a
# connection error that reads like a network problem; an empty AUTH_SECRET is
# `MissingSecret` from Auth.js, logged on requests that have nothing to do with
# auth.
FATAL_KEYS="DATABASE_URL AUTH_SECRET"

# WARN: the app boots and most of it works. Penny does not, and email does not,
# but that is a coherent state to develop the rest of the app in — and it is
# the state a contributor with no Anthropic key of their own is permanently in.
# Making these fatal would lock them out of a working trips list.
WARN_KEYS="ANTHROPIC_API_KEY AUTH_RESEND_KEY"

fatal_count=0
warn_count=0

report() {
  local key="$1" severity="$2"

  env_resolve "$key"
  [ -n "$ENV_EFFECTIVE" ] && return 0

  # Two different failures wearing the same word. An empty ENV_EFFECTIVE_SOURCE
  # means the key is declared NOWHERE; a set one means some file declared it
  # empty, and says which — the case that motivated this script.
  local detail
  if [ -n "$ENV_EFFECTIVE_SOURCE" ]; then
    detail="declared EMPTY in $ENV_EFFECTIVE_SOURCE"
  else
    detail="not set in the environment, .env.local or .env"
  fi

  if [ "$severity" = fatal ]; then
    printf '\033[1;31m  ✗ %s — %s\033[0m\n' "$key" "$detail" >&2
    fatal_count=$((fatal_count + 1))
  else
    printf '\033[1;33m  ! %s — %s\033[0m\n' "$key" "$detail" >&2
    warn_count=$((warn_count + 1))
  fi

  # Only worth saying when a good value actually exists and is being overridden.
  # Without this line the reader opens .env, finds the key, and disbelieves the
  # error — which is exactly how this cost an afternoon the first time.
  if [ -n "$ENV_USABLE" ] && [ -n "$ENV_USABLE_SOURCE" ]; then
    printf '      a real value exists in %s — %s is shadowing it\n' \
      "$ENV_USABLE_SOURCE" "$ENV_EFFECTIVE_SOURCE" >&2
  fi
}

for key in $FATAL_KEYS; do report "$key" fatal; done
for key in $WARN_KEYS;  do report "$key" warn;  done

if [ "$fatal_count" -gt 0 ]; then
  printf '\033[1;31m\nRefusing to start: %d required environment variable(s) resolve to empty.\033[0m\n' \
    "$fatal_count" >&2
  cat >&2 <<'EOF'

  Next loads .env.local AHEAD of .env, and it does NOT skip empty values —
  `KEY=` sets the variable to the empty string rather than falling through to
  the next file. `vercel env pull` writes a .env.local containing every key
  with an empty value, which is how a correct .env ends up powering a server
  that has none.

  If the file above is a `vercel env pull` artefact you did not mean to keep:

      rm .env.local

  Otherwise give it a real value, or delete that one line so .env is used.

EOF
  exit 1
fi

exit 0
