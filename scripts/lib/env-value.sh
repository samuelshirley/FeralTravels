# Resolving an env var the way this repo's tooling needs to see it.
#
# SOURCED, never executed. Two callers, deliberately sharing one implementation:
# `scripts/check-env.sh` (the predev guard) and `scripts/ios-e2e-local.sh` (the
# local iOS e2e loop). A second copy would drift, and it would be the copy
# nobody is looking at.
#
# ── Why this file exists ───────────────────────────────────────────────────
#
# `grep '^KEY=' .env` is the obvious check and it is wrong. Next loads
# `.env.local` AHEAD of `.env`, and `vercel env pull` writes a `.env.local`
# listing every key with an EMPTY value — so a repo with a perfectly good
# ANTHROPIC_API_KEY in `.env` runs a server that has none, and a check that
# greps `.env` cheerfully passes.
#
# That is not hypothetical. It is why `/api/trip/replan` answered 503 to every
# send while the iOS chat-keyboard flow went green, and why the same log filled
# with `MissingSecret` from an AUTH_SECRET the iOS doctor had just declared
# present. Deleting that `.env.local` fixes today; the next `vercel env pull`
# writes it back, which is what the guard is for.
#
# ── The two questions, which have different answers ────────────────────────
#
# EFFECTIVE — what dotenv will actually hand the app. An empty declaration
#   COUNTS: dotenv does not skip `KEY=`, it sets the variable to the empty
#   string, and that is precisely the bug. This is what a guard must ask.
#
# USABLE — the best non-empty value anywhere, skipping empty declarations. This
#   is what a caller asks when it intends to PASS the value explicitly in the
#   process environment, where it outranks every file. Only `ios-e2e-local.sh`
#   does that, and only because it starts the server itself.
#
# Both honour the same precedence: process env, then `.env.local`, then `.env`.

# Files dotenv reads, highest precedence first. `.env.development` and the rest
# of Next's cascade are not listed because this repo does not use them; add them
# here and both callers get it.
ENV_FILES=".env.local .env"

# Print the raw declaration of $2 in file $1. Returns 1 when the key is not
# declared at all, which is what distinguishes "missing" from "present but
# empty" — the whole point of this file.
#
# The LAST assignment in a file wins, matching dotenv. Strips an `export `
# prefix and one layer of surrounding quotes.
env_declaration() {
  local file="$1" key="$2"
  [ -f "$file" ] || return 1
  awk -v k="$key" '
    { line = $0; sub(/^[[:space:]]*export[[:space:]]+/, "", line) }
    index(line, k "=") == 1 {
      val = substr(line, length(k) + 2)
      sub(/^"/, "", val); sub(/"$/, "", val)
      sub(/^'"'"'/, "", val); sub(/'"'"'$/, "", val)
      out = val; found = 1
    }
    END { if (!found) exit 1; print out }
  ' "$file"
}

# ── The resolver ───────────────────────────────────────────────────────────
#
# Answers BOTH questions for $1 in GLOBALS, and prints nothing:
#
#   ENV_EFFECTIVE         what dotenv will hand the app (may be empty)
#   ENV_EFFECTIVE_SOURCE  where that came from; "" when declared nowhere
#   ENV_USABLE            the best non-empty value anywhere; "" when there is none
#   ENV_USABLE_SOURCE     where THAT came from
#
# Globals rather than stdout because the source is half the answer, and
# `$(env_effective KEY)` runs in a SUBSHELL — any variable it set dies with it.
# That is a quiet way to report the wrong filename, so there is no stdout
# variant of this to reach for by mistake.
#
# When ENV_EFFECTIVE is empty and ENV_USABLE is not, the two sources name the
# shadowing file and the shadowed one, which is the sentence worth printing.
env_resolve() {
  local key="$1" f v
  ENV_EFFECTIVE=""; ENV_EFFECTIVE_SOURCE=""
  ENV_USABLE="";    ENV_USABLE_SOURCE=""

  # dotenv never overwrites a variable already in the environment, so a real
  # exported value wins outright. An exported EMPTY one is indistinguishable
  # from an unset one here, and dotenv treats it as unset too.
  if [ -n "${!key:-}" ]; then
    ENV_EFFECTIVE="${!key}";       ENV_EFFECTIVE_SOURCE="process env"
    ENV_USABLE="${!key}";          ENV_USABLE_SOURCE="process env"
    return 0
  fi

  for f in $ENV_FILES; do
    if v="$(env_declaration "$f" "$key")"; then
      # The first file that DECLARES the key decides what the app gets, empty
      # or not. Recorded once; later files cannot change it.
      if [ -z "$ENV_EFFECTIVE_SOURCE" ]; then
        ENV_EFFECTIVE="$v"; ENV_EFFECTIVE_SOURCE="$f"
      fi
      # Keep looking for something actually usable, so a shadowed-but-correct
      # value can be named in the error.
      if [ -n "$v" ] && [ -z "$ENV_USABLE_SOURCE" ]; then
        ENV_USABLE="$v"; ENV_USABLE_SOURCE="$f"
      fi
    fi
  done
  return 0
}

# The best usable (non-empty) value for $1, on stdout. Empty output means there
# is no usable value anywhere. This is the one `ios-e2e-local.sh` passes into
# the server's environment, so a subshell is fine and the source is not needed.
env_value() {
  env_resolve "$1"
  printf '%s' "$ENV_USABLE"
}
