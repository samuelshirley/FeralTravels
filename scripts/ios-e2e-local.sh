#!/usr/bin/env bash
#
# Run the Maestro iOS flows on THIS Mac, against a local server and a local
# database, in about a minute instead of eighteen.
#
# ── Why this exists ────────────────────────────────────────────────────────
#
# The flows in mobile/maestro/ were written from the source and had never once
# been executed when they were merged. Every selector, every wait and every
# assumption about what the app does on launch was a guess, and the only place
# they ran was a macOS CI job that takes ~18 minutes, fails all three of its
# layers with the same message, and — until the fix that landed beside this
# script — uploaded an empty artifact. That is not a feedback loop; it is a
# slot machine.
#
# So: build once, then re-run a flow in seconds. Everything the run learns is
# written under mobile/maestro/.local-run/ (gitignored) — logs, the JUnit
# report, Maestro's own debug output, screenshots, and a view-hierarchy dump —
# so a failure can be read from files rather than reconstructed from a summary
# line.
#
# ── The three layers, and why they are separate ────────────────────────────
#
# A red run means one of three things, and they need different fixes:
#
#   1. HARNESS   — Xcode/driver/simulator. `launch.yaml` is the smoke flow:
#                  app installs, launches, sign-in screen renders. If this is
#                  red nothing else means anything.
#   2. WIRING    — the app can reach the server and sign in. `sign-in.yaml`.
#   3. BEHAVIOUR — the thing under test. `chat-keyboard.yaml`, and
#                  `settings-location.yaml` for the one class of UI that
#                  cannot be checked by looking at it: a permission button
#                  that renders perfectly and calls nothing is
#                  indistinguishable from one that works, until a device says
#                  otherwise.
#
# `--all` runs them in that order and stops at the first failure, so the first
# line of output names the layer.
#
# ── Usage ──────────────────────────────────────────────────────────────────
#
#   scripts/ios-e2e-local.sh doctor        # check the machine, change nothing
#   scripts/ios-e2e-local.sh up            # db + server, leave them running
#   scripts/ios-e2e-local.sh build         # prebuild + xcodebuild + install
#   scripts/ios-e2e-local.sh run [flow]    # mint a fixture, run one flow
#   scripts/ios-e2e-local.sh all           # doctor, up, build-if-needed, 1→2→3
#   scripts/ios-e2e-local.sh hierarchy     # dump the current screen's view tree
#   scripts/ios-e2e-local.sh studio        # Maestro Studio against this device
#   scripts/ios-e2e-local.sh storekit      # point the scheme at the local store
#   scripts/ios-e2e-local.sh xcode         # open the workspace to drive a purchase
#   scripts/ios-e2e-local.sh screenshots [size]
#                                          # the App Store set, into
#                                          # mobile/screenshots/<size>/ (default 6.9)
#   scripts/ios-e2e-local.sh down          # stop the server and the database
#   scripts/ios-e2e-local.sh reset         # down, and delete the database volume
#
# `run` and `hierarchy` assume `up` and `build` have already happened, which is
# what makes the iteration loop fast: change a flow, `run` it, ~60 seconds.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

OUT="mobile/maestro/.local-run"
PORT="${E2E_LOCAL_PORT:-4310}"
API_URL="http://localhost:${PORT}"
# 127.0.0.1, not localhost: the container publishes on the host's loopback and
# some Docker setups only bind the v4 address, so `localhost` can resolve to ::1
# and time out with a message about the database being unreachable.
DB_URL="postgres://feral:feral@127.0.0.1:55432/feraltravels_e2e"
APP_ID="com.feraltravels.ios"
MAESTRO_PIN="2.10.0"
# The toolchain Maestro's PREBUILT iOS driver was built with. Not a preference:
# an older xcodebuild cannot run its .xctestrun, and the only symptom is
# "iOS driver not ready in time", which sounds like a slow machine. Kept in step
# with the same constant in .github/workflows/ci.yml.
XCODE_APP="${E2E_XCODE_APP:-/Applications/Xcode_26.2.app}"

# The local StoreKit store — a fake App Store in a JSON file, so a purchase can
# be exercised in the simulator with no App Store Connect round trip and no
# sandbox Apple Account. See mobile/storekit/README.md for what it does and does
# NOT remove (RevenueCat's dashboard is still required).
#
# TRACKED, and it has to be: mobile/ios/ is gitignored CNG output that
# `expo prebuild --clean` deletes wholesale, so a .storekit kept in there would
# survive exactly one build.
STOREKIT_FILE="mobile/storekit/FeralTravels.storekit"

# ── The names the seeded graph wears ───────────────────────────────────────
#
# The test flows want a name that is obviously a fixture; the screenshot flow
# wants one a customer could read on the App Store. Same canonical two legs
# either way — Paris → Strasbourg → Stuttgart is a real route with real road
# geometry, which is why it photographs well — only the labels differ.
#
# `sign-in.yaml` and `chat-keyboard.yaml` match the trip card against
# ${TRIP_NAME}, so this and the seed have to move together. `screenshots`
# overrides all three.
TRIP_NAME="${E2E_TRIP_NAME:-E2E Fixture Trip}"
VEHICLE_NAME="${E2E_VEHICLE_NAME:-E2E Fixture Van}"
USER_NAME="${E2E_USER_NAME:-E2E Fixture User}"

# Fixture vehicle range. EMPTY for the test flows, which want the Hilux's real
# 500 km — day 1 (Paris → Strasbourg, 489 km) then needs no fuel stop, which is
# correct and is what those flows assert around.
#
# `screenshots` overrides it, because that is exactly the wrong picture for the
# App Store: the shot whose purpose is "the itinerary, with fuel stops" came out
# reading "No fuel stop needed on this day". A shorter range makes the same leg
# genuinely need one, so the image shows Finn doing the thing the app is for.
RANGE_KM="${E2E_RANGE_KM:-}"

# Where Maestro puts a named `takeScreenshot`.
#
# NOT ours to choose. Maestro 2.10 sandboxes the command — an absolute path
# outside its own output folder is refused outright ("it resolves outside this
# run's takeScreenshot output folder"), which is what the first real run of
# screenshots.yaml died on, after getting all the way through sign-in. So the
# flow uses BARE names and the images land under the --debug-output tree at
# `<out>/.maestro/tests/<timestamp>/<flow>/takeScreenshot/`. `collect_shots`
# below finds that directory rather than hard-coding the timestamp.
MAESTRO_SHOT_GLOB=".maestro/tests/*/screenshots/takeScreenshot"

# ── App Store screenshots ──────────────────────────────────────────────────
#
# Committed, because a screenshot nobody can regenerate is a screenshot that
# silently describes last release's app — and because the alternative is
# Cmd-S into ~/Desktop and a folder of numbered PNGs with no record of which
# build produced them.
SHOT_ROOT="mobile/screenshots"

mkdir -p "$OUT"

# ── Where the throwaway database comes from ────────────────────────────────
#
# Docker is the documented path and stays the default. The fallback is an
# ordinary Homebrew postgres on the SAME port, because Docker Desktop is a GUI
# install with a licence prompt and a Mac without it should not be a Mac that
# cannot run these flows. Both produce the identical $DB_URL; the only thing
# that actually matters is that neither is the production Neon endpoint in .env.
PG_LOCAL_DATA="${E2E_PG_DATA:-$HOME/.feraltravels-e2e-pg}"
PG_LOCAL_BIN="${E2E_PG_BIN:-/opt/homebrew/opt/postgresql@16/bin}"

db_mode() {
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    echo docker
  elif [ -x "$PG_LOCAL_BIN/pg_ctl" ]; then
    echo local
  else
    echo none
  fi
}

# ── The value the SERVER will actually see ─────────────────────────────────
#
# `env_value` resolves a key the way dotenv does — process env, then
# `.env.local`, then `.env` — but skips EMPTY declarations, which is what makes
# it useful here: `up` passes the result explicitly into the server's
# environment, where it outranks every file, so a shadowing empty value in
# `.env.local` cannot reach the server.
#
# SHARED with scripts/check-env.sh, the predev guard, rather than reimplemented.
# The two ask slightly different questions of the same precedence rules and the
# rules are the part that would rot in duplicate. The long version of why any of
# this exists is in the header of the lib.
# shellcheck source=scripts/lib/env-value.sh
. "$REPO_ROOT/scripts/lib/env-value.sh"

# Each helper prints AND appends to the run report. Deliberately not a
# `{ ... } | tee` around the whole function: a pipeline puts the body in a
# subshell, where `die`'s `exit 1` ends the subshell and the script sails on to
# build an app on a machine that just failed its preflight.
REPORT="$OUT/run.txt"
: > "$REPORT"
log()  { printf '%s\n' "$*" >> "$REPORT"; }
say()  { printf '\033[1;36m▸ %s\033[0m\n' "$*"; log "▸ $*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; log "  ok   $*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; log "  WARN $*"; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; log "  FAIL $*"; exit 1; }

# ───────────────────────────────────────────────────────────────────────────
# doctor — every prerequisite, checked before anything slow happens
# ───────────────────────────────────────────────────────────────────────────
doctor() {
  say "Checking this machine"

  [ "$(uname)" = "Darwin" ] || die "This runs on macOS. A simulator needs Xcode."
  ok "macOS $(sw_vers -productVersion) on $(uname -m)"

  command -v xcodebuild >/dev/null || die "No xcodebuild. Install Xcode from the App Store."
  local xver
  # `| head -1` closes the pipe on a process that is still writing, and
  # `set -o pipefail` then reports the SIGPIPE (141) as the pipeline's status,
  # which `set -e` turns into an exit with NO message at all — the doctor
  # printed the macOS line and vanished. awk reads to EOF, so it cannot race.
  xver="$(xcodebuild -version | awk 'NR==1 {print $2}')"
  local xmajor="${xver%%.*}"
  if [ "$xmajor" -lt 26 ]; then
    printf '\n'
    warn "Selected Xcode is $xver, and Maestro ${MAESTRO_PIN}'s prebuilt driver was built with 26.2."
    warn "An older xcodebuild cannot run its .xctestrun. The symptom is a 120s"
    warn "'iOS driver not ready in time', which reads like a slow simulator and is not."
    printf '\n  Installed Xcodes:\n'
    ls -d /Applications/Xcode*.app 2>/dev/null | sed 's/^/    /'
    local suggest
    suggest="$(ls -d /Applications/Xcode*.app 2>/dev/null | sort -V | tail -1)"
    printf '\n  Fix:\n    sudo xcode-select -s %s/Contents/Developer\n\n' "${suggest:-$XCODE_APP}"
    die "Wrong Xcode selected."
  fi
  ok "Xcode $xver ($(xcode-select -p))"

  # NOT `command -v java`. macOS ships a stub at /usr/bin/java that exists on
  # every machine and whose entire job is to print "Unable to locate a Java
  # Runtime" — so the presence check passes on a Mac with no JDK at all, and
  # this doctor cheerfully reported `✓ java The operation couldn't be
  # completed`. Run it and read the exit code instead.
  local jver
  if ! jver="$(java -version 2>&1)" || printf '%s' "$jver" | grep -qi 'unable to locate a java runtime'; then
    printf '\n  Maestro is a JVM program and needs a real JDK 17 — the one its own\n'
    printf '  CI uses. macOS has a stub at /usr/bin/java that is not one.\n'
    printf '\n  Fix:\n    brew install --cask zulu@17\n\n'
    die "No Java runtime."
  fi
  local jmajor
  jmajor="$(printf '%s' "$jver" | head -1 | sed -E 's/.*"([0-9]+).*/\1/')"
  if [ -n "$jmajor" ] && [ "$jmajor" -lt 17 ] 2>/dev/null; then
    warn "Java $jmajor; Maestro's own CI builds and runs on 17. Upgrade if the driver misbehaves."
  fi
  ok "java $(printf '%s' "$jver" | head -1 | sed -E 's/.*"([^\"]*)".*/\1/')"

  if ! command -v maestro >/dev/null; then
    printf '\n  Fix — install it, then make the PATH stick:\n'
    printf '    export MAESTRO_VERSION=%s\n' "$MAESTRO_PIN"
    printf '    curl -Ls https://get.maestro.mobile.dev | bash\n'
    printf '    echo '"'"'export PATH="$HOME/.maestro/bin:$PATH"'"'"' >> ~/.zshrc\n'
    printf '    source ~/.zshrc\n\n'
    printf '  The installer needs Java to already be there, so do Java first.\n\n'
    die "No maestro on PATH."
  fi
  local mver
  mver="$(maestro --version 2>/dev/null | tail -1 | tr -d '[:space:]')"
  if [ "$mver" != "$MAESTRO_PIN" ]; then
    warn "maestro $mver, but CI pins $MAESTRO_PIN — a local pass may not mean a CI pass."
    warn "  export MAESTRO_VERSION=$MAESTRO_PIN; curl -Ls https://get.maestro.mobile.dev | bash"
  else
    ok "maestro $mver (matches CI)"
  fi

  case "$(db_mode)" in
    docker) ok "docker running (database in a container)" ;;
    local)  ok "postgres at $PG_LOCAL_BIN (no docker; cluster in $PG_LOCAL_DATA)" ;;
    *)
      printf '\n  The flows call /api/test/seed, and the only DATABASE_URL in .env is\n'
      printf '  PRODUCTION. So this needs a throwaway database on port 55432. Either:\n'
      printf '\n    Docker Desktop, then start it        (docker compose -f docker-compose.e2e.yml)\n'
      printf '    brew install postgresql@16           (no GUI, no licence prompt)\n\n'
      die "No database available."
      ;;
  esac

  command -v node >/dev/null || die "No node."
  ok "node $(node -v)"

  [ -f .env ] || die "No .env — the local server still needs ANTHROPIC_API_KEY and AUTH_SECRET from it."
  # The EFFECTIVE value, not a line in a file. See env_value above: the old
  # check grepped `.env`, passed, and the server started with an empty key
  # anyway because `.env.local` shadowed it.
  local anthropic auth_secret
  anthropic="$(env_value ANTHROPIC_API_KEY)"
  auth_secret="$(env_value AUTH_SECRET)"
  if [ -z "$auth_secret" ]; then
    printf '\n  Checked the process env, .env.local and .env, in that order.\n'
    printf '  A key present-but-EMPTY does not count — and a .env.local written by\n'
    printf '  the Vercel CLI lists every key with an empty value.\n\n'
    die "AUTH_SECRET resolves to nothing; sign-in cannot mint a session."
  fi
  if [ -z "$anthropic" ]; then
    warn "ANTHROPIC_API_KEY resolves to nothing (checked process env, .env.local, .env)."
    warn "  chat-keyboard sends a real message: /api/trip/replan will answer 503."
    warn "  The flow asserts on the composer clearing, so it stays green — but the"
    warn "  screen will read 'AI service is temporarily unavailable'."
  fi
  ok "env resolves the keys the server needs"

  local udid label
  if ! read -r udid label < <(node scripts/pick-ios-simulator.mjs); then
    die "No usable iPhone simulator. Open Xcode → Settings → Components and install an iOS runtime."
  fi
  ok "simulator: $label"
  ok "device id: $udid"

  say "Everything the run needs is present"
}

start_db() {
  case "$(db_mode)" in
    docker)
      say "Starting the local database (docker)"
      docker compose -f docker-compose.e2e.yml up -d --wait
      ok "postgres on 55432 (container)"
      ;;
    local)
      say "Starting the local database (postgres on this machine)"
      if ! "$PG_LOCAL_BIN/pg_isready" -h 127.0.0.1 -p 55432 -q 2>/dev/null; then
        # trust auth on a loopback-only cluster: the password in $DB_URL is then
        # ignored, which is why the URL does not have to be kept in step here.
        [ -d "$PG_LOCAL_DATA" ] || "$PG_LOCAL_BIN/initdb" -D "$PG_LOCAL_DATA" \
          -U feral --auth-local=trust --auth-host=trust -E UTF8 >"$OUT/db.log" 2>&1 \
          || { tail -20 "$OUT/db.log"; die "initdb failed — see $OUT/db.log"; }
        "$PG_LOCAL_BIN/pg_ctl" -D "$PG_LOCAL_DATA" -l "$PG_LOCAL_DATA/server.log" \
          -o "-p 55432 -k /tmp" -w start >>"$OUT/db.log" 2>&1 \
          || { tail -20 "$PG_LOCAL_DATA/server.log"; die "postgres would not start"; }
      fi
      "$PG_LOCAL_BIN/psql" -h 127.0.0.1 -p 55432 -U feral -d postgres -tAc \
        "select 1 from pg_database where datname='feraltravels_e2e'" 2>/dev/null | grep -q 1 \
        || "$PG_LOCAL_BIN/createdb" -h 127.0.0.1 -p 55432 -U feral feraltravels_e2e
      # UTC, like Neon — and NOT cosmetic. `email_otp_codes.created_at` is a
      # `timestamp` WITHOUT time zone, so Postgres stores the server's local
      # wall clock while drizzle reads it back as UTC. On a cluster in any other
      # zone those disagree, the OTP resend cooldown computes a NEGATIVE age and
      # therefore never expires, and every resend is a 429 forever. That made
      # the iOS sign-in flow unable to fail locally while it failed on every CI
      # run — a second bug perfectly hiding the first. Pinning this is what lets
      # a local pass mean something.
      "$PG_LOCAL_BIN/psql" -h 127.0.0.1 -p 55432 -U feral -d feraltravels_e2e \
        -c "alter database feraltravels_e2e set timezone to 'UTC'" >/dev/null 2>&1 || true
      ok "postgres on 55432 (local cluster, UTC)"
      ;;
    *) die "No database available — run doctor." ;;
  esac
}

# ───────────────────────────────────────────────────────────────────────────
# up — database + schema + server, warmed
# ───────────────────────────────────────────────────────────────────────────
up() {
  start_db

  # ── Schema ────────────────────────────────────────────────────────────────
  #
  # An EMPTY database is bootstrapped with `drizzle-kit push` and then has its
  # journal seeded, rather than being brought up by replaying drizzle/*.sql.
  # That is not a shortcut: THE SQL CHAIN CANNOT RUN FROM EMPTY, and never
  # could. `0005_mute_meltdown` and `0006_nightly_replan` both `CREATE TYPE
  # "trip_status"` and both `ADD COLUMN trips.trip_status`, the second without
  # a guard, so a fresh run dies on `42710 type already exists`. Behind it,
  # `0002_magical_joystick` calls `setval(seq, 0)` on an empty chat_history,
  # which is out of range for a serial and aborts with `22003`.
  #
  # Nothing noticed because nothing has ever needed it: production was itself
  # bootstrapped with push (see the header of scripts/seed-migration-journal.ts)
  # and CI's preview branch is a copy-on-write CLONE of production, so both
  # start from a database that already has the schema and only ever apply the
  # newest file. This path is the one the repo already documents for that case.
  #
  # A database that already has tables takes the normal `db:migrate`, so a new
  # migration is still exercised here exactly as it will be against prod.
  local tables
  tables="$("$PG_LOCAL_BIN/psql" -h 127.0.0.1 -p 55432 -U feral -d feraltravels_e2e \
    -tAc "select count(*) from information_schema.tables where table_schema='public'" 2>/dev/null || echo 0)"
  if [ "${tables:-0}" -lt 2 ]; then
    say "Bootstrapping an empty database (push + journal seed)"
    DATABASE_URL="$DB_URL" npx drizzle-kit push --force >"$OUT/migrate.log" 2>&1 \
      || { tail -30 "$OUT/migrate.log"; die "Schema push failed — see $OUT/migrate.log"; }
    DATABASE_URL="$DB_URL" npx tsx scripts/seed-migration-journal.ts >>"$OUT/migrate.log" 2>&1 \
      || { tail -30 "$OUT/migrate.log"; die "Journal seed failed — see $OUT/migrate.log"; }
    ok "schema created from schema.ts"
  else
    say "Applying migrations"
    DATABASE_URL="$DB_URL" npm run db:migrate >"$OUT/migrate.log" 2>&1 \
      || { tail -30 "$OUT/migrate.log"; die "Migrations failed — see $OUT/migrate.log"; }
    ok "schema is current"
  fi

  if curl -fsS "$API_URL/login" >/dev/null 2>&1; then
    ok "server already answering on $API_URL"
  else
    say "Starting the server on $API_URL"
    # Values passed in the environment, NOT written into a .env file: Next gives
    # the real process environment precedence over .env, so this overrides the
    # production DATABASE_URL in .env without editing a tracked-adjacent file
    # that could later be committed or forgotten.
    #
    # E2E_TEST_ENDPOINTS=1 arms /api/test/* — the same switch CI sets, hard-off
    # on VERCEL_ENV=production with no override, so it cannot leak anywhere.
    # No E2E_TEST_ENDPOINTS_SECRET: locally there is nothing to lock out.
    # ANTHROPIC_API_KEY and AUTH_SECRET are passed the same way DATABASE_URL is,
    # and for the same reason: the process environment outranks every .env file,
    # so this is the only way to beat the empty-valued `.env.local` that Next
    # would otherwise load ahead of `.env`. Without it the server runs with no
    # Anthropic key and answers 503 to every replan.
    DATABASE_URL="$DB_URL" \
    ANTHROPIC_API_KEY="$(env_value ANTHROPIC_API_KEY)" \
    AUTH_SECRET="$(env_value AUTH_SECRET)" \
    AUTH_URL="$API_URL" \
    NEXTAUTH_URL="$API_URL" \
    E2E_TEST_ENDPOINTS=1 \
    PORT="$PORT" \
      nohup npx next dev -p "$PORT" >"$OUT/server.log" 2>&1 &
    echo $! > "$OUT/server.pid"

    local deadline=$((SECONDS + 120))
    until curl -fsS "$API_URL/login" >/dev/null 2>&1; do
      [ $SECONDS -lt $deadline ] || { tail -40 "$OUT/server.log"; die "Server never came up — see $OUT/server.log"; }
      sleep 2
    done
    ok "server up (pid $(cat "$OUT/server.pid"))"
  fi

  # WARMING IS NOT OPTIONAL in dev mode. `next dev` compiles a route the first
  # time it is requested, and the flows' waits are 30s. An uncompiled
  # /api/mobile/otp/verify can spend most of that budget on webpack and fail a
  # flow for a reason that has nothing to do with the app.
  say "Warming the routes the flows hit"
  for path in /login /api/me /api/test/seed /api/mobile/otp/send /api/mobile/otp/verify /api/trips; do
    curl -o /dev/null -s -m 90 "$API_URL$path" || true
  done
  ok "routes compiled"
}

# ───────────────────────────────────────────────────────────────────────────
# build — the same commands CI runs, so a local pass means something
# ───────────────────────────────────────────────────────────────────────────
build() {
  say "Building the app for the simulator (this is the slow one, ~10 min cold)"
  (
    cd mobile
    # EXPORTED, not a one-command prefix. In Release the JS bundle is built by
    # xcodebuild's "Bundle React Native code and images" phase, which is where
    # EXPO_PUBLIC_API_URL is inlined — so it has to be in the environment for
    # xcodebuild too, not only for prebuild.
    export EXPO_PUBLIC_API_URL="$API_URL"

    # ── The two flags that decide what this binary IS ────────────────────
    #
    # Both are `EXPO_PUBLIC_`, so they are inlined at bundle time and compiled
    # in; neither can be turned on afterwards by an OTA, and `eas.json` sets
    # both on the `preview` and `production` profiles. Until this block existed
    # the local loop exported only EXPO_PUBLIC_API_URL, which meant every app
    # this script has ever built differed from the one that ships in exactly
    # the two places most likely to be rejected:
    #
    #   EXPO_PUBLIC_REVENUECAT_IOS_KEY   absent -> `purchasesAvailable()` is
    #     false, `Purchases.configure` never runs, and the purchase sheet
    #     renders in `unavailable` mode. Prices, no checkout. Everything about
    #     the in-app-purchase work looks fine and none of it is exercised.
    #
    #   EXPO_PUBLIC_ENABLE_APPLE_SIGNIN  absent -> `app.config.js` omits BOTH
    #     the `expo-apple-authentication` plugin and `ios.usesAppleSignIn`, so
    #     the entitlement `com.apple.developer.applesignin` is never written,
    #     the module is not linked, `appleAvailable()` returns false and the
    #     button does not render. A build with no Apple sign-in in it is a
    #     guideline 4.8 rejection, and this loop could not have shown you.
    #
    # Resolved through `env_value` — process env, then .env.local, then .env,
    # skipping empty declarations — so `.env` is the place to put them and a
    # Vercel-written empty line cannot shadow one. Absent stays a supported
    # state (both clients degrade deliberately); it is just no longer a SILENT
    # one, which is the whole change.
    local rc_key apple_signin
    rc_key="$(env_value EXPO_PUBLIC_REVENUECAT_IOS_KEY)"
    apple_signin="$(env_value EXPO_PUBLIC_ENABLE_APPLE_SIGNIN)"

    if [ -n "$rc_key" ]; then
      export EXPO_PUBLIC_REVENUECAT_IOS_KEY="$rc_key"
      echo "RevenueCat: key present, real purchases enabled in this build"
    else
      echo "RevenueCat: NO KEY — the purchase sheet will show prices and no checkout."
      echo "  Put EXPO_PUBLIC_REVENUECAT_IOS_KEY=appl_… in .env to build the real thing."
      echo "  (mobile/lib/config.ts requires the appl_ prefix, so eas.json's"
      echo "   REPLACE_WITH_… placeholder correctly resolves to unset, not to a key.)"
    fi

    if [ "$apple_signin" = "1" ]; then
      export EXPO_PUBLIC_ENABLE_APPLE_SIGNIN=1
      echo "Sign in with Apple: ENABLED (entitlement + plugin will be prebuilt in)"
    else
      echo "Sign in with Apple: OFF — no entitlement, no button, cannot be tested."
      echo "  EXPO_PUBLIC_ENABLE_APPLE_SIGNIN=1 in .env turns it on. A SIMULATOR"
      echo "  build signs ad hoc and will compile with the entitlement, but the"
      echo "  sign-in itself needs a device build against a provisioning profile"
      echo "  carrying the capability — see docs/design/ios-review-notes.md."
    fi

    npx expo prebuild --platform ios --clean
    local workspace scheme
    workspace="$(ls -d ios/*.xcworkspace | head -1)"
    scheme="$(basename "$workspace" .xcworkspace)"
    echo "API base baked into this build: $EXPO_PUBLIC_API_URL"
    # RELEASE, and this is the whole reason layer 1 could never have passed.
    #
    # A Debug build contains NO JavaScript. React Native's Debug path fetches
    # the bundle from a Metro packager on localhost:8081 at launch, and nothing
    # here runs one — so the app came up showing the red box "No script URL
    # provided. Make sure the packager is running", which has no `signin-email`
    # in it and never would. The 30s wait then timed out on an assertion about
    # a screen the app was never going to draw.
    #
    # Release runs the bundling phase at build time, so the .app is
    # self-contained: no packager, no port, and the JS under test is the same
    # shape that ships. It also means EXPO_PUBLIC_API_URL is baked in here
    # rather than read at runtime, which is what makes a build point at one
    # specific server.
    # CODE_SIGNING_ALLOWED=NO was here. It has to go, and this is not a
    # preference. `expo-secure-store` is where the session token lives, and
    # the keychain refuses an app with no entitlements: sign-in completed,
    # `POST /api/mobile/otp/verify` returned 200, and the app then died on
    # "Calling the 'setValueWithKeyAsync' function has failed → Caused by: A
    # required entitlement isn't present", stranded on the code screen holding
    # a session it could not store. `setToken` does not catch that on purpose.
    # A simulator build signs ad hoc and needs no team, account or profile, so
    # dropping the flag costs nothing.
    xcodebuild -workspace "$workspace" \
      -scheme "$scheme" \
      -configuration Release \
      -sdk iphonesimulator \
      -derivedDataPath ios/build
    mkdir -p ios-build
    rm -rf ios-build/*.app
    cp -R ios/build/Build/Products/Release-iphonesimulator/*.app ios-build/
  ) >"$OUT/build.log" 2>&1 || { tail -40 "$OUT/build.log"; die "Build failed — see $OUT/build.log"; }
  ok "built $(ls -d mobile/ios-build/*.app | head -1)"
  # After the compile, not before: `expo prebuild --clean` above rewrites the
  # scheme from scratch, so the reference has to be put back every time. It
  # changes nothing about the binary just built — the scheme is Xcode's, and the
  # Maestro flows launch outside it — so it is free and it means `xcode` works
  # without a second command.
  storekit
  install_app
}

# ───────────────────────────────────────────────────────────────────────────
# storekit — point the generated scheme at the local store
# ───────────────────────────────────────────────────────────────────────────
#
# Idempotent, and run as part of `build` because `expo prebuild --clean` writes
# a fresh scheme every time and the reference has to be put back afterwards.
#
# WHAT IT BUYS: prices, Apple's confirmation dialog, cancel, Ask to Buy and
# accelerated renewals in the simulator with no App Store Connect round trip and
# no sandbox Apple Account. What it does NOT remove is RevenueCat — the app asks
# RevenueCat for an Offering and RevenueCat looks the products up through
# StoreKit, so this satisfies the second step and not the first.
# mobile/storekit/README.md has the table.
#
# WHAT IT DOES NOT COVER, stated rather than implied: the Maestro flows. The
# configuration is activated by the SCHEME's launch action, and Maestro installs
# the .app with `simctl install` and launches it outside any scheme. There is no
# `simctl storekit` subcommand as of Xcode 26.6 (checked with `simctl help`, not
# assumed), so a purchase has to be driven from Xcode's Run — hence `xcode`
# below. This is why no flow in mobile/maestro/ attempts one.
#
# The identifier is a path RELATIVE TO THE .xcodeproj, which is why it climbs
# out of ios/ before descending into storekit/.
storekit() {
  local proj_dir="mobile/ios"
  local scheme_file="$proj_dir/FeralTravels.xcodeproj/xcshareddata/xcschemes/FeralTravels.xcscheme"
  [ -f "$STOREKIT_FILE" ] || die "No $STOREKIT_FILE"
  if [ ! -f "$scheme_file" ]; then
    warn "No generated scheme yet — run \`build\` first."
    return 0
  fi

  # Copied BESIDE the .xcodeproj rather than referenced across the tree. The
  # scheme's `identifier` is a path relative to the .xcodeproj bundle, so
  # "../FeralTravels.storekit" resolving to a file sitting next to it is the
  # exact layout Xcode itself writes when you add a configuration file to a
  # normal project — the shape least likely to be wrong. mobile/ios/ is
  # gitignored CNG output, so this copy is disposable and the tracked original
  # in mobile/storekit/ stays the source of truth.
  cp "$STOREKIT_FILE" "$proj_dir/FeralTravels.storekit"

  if grep -q "StoreKitConfigurationFileReference" "$scheme_file"; then
    ok "scheme already points at the local store"
    return 0
  fi

  # Both actions: LaunchAction is Xcode's Run button, TestAction is
  # `xcodebuild test`. Pointing only one of them at it is the kind of thing that
  # works until the day you use the other.
  python3 - "$scheme_file" <<'PYEOF'
import re, sys
path = sys.argv[1]
src = open(path).read()
ref = (
    '      <StoreKitConfigurationFileReference\n'
    '         identifier = "../FeralTravels.storekit">\n'
    '      </StoreKitConfigurationFileReference>\n'
)
for action in ("LaunchAction", "TestAction"):
    # Match the closing tag WITH its own indentation, so the inserted element
    # lands on its own line rather than splicing in front of the tag.
    src = re.sub(rf"^([ \t]*)</{action}>", ref + rf"\1</{action}>", src, count=1, flags=re.M)
open(path, "w").write(src)
PYEOF
  grep -q "StoreKitConfigurationFileReference" "$scheme_file" \
    || die "Could not write the StoreKit reference into $scheme_file"
  ok "scheme points at the local store"
  warn "If Xcode's scheme editor shows StoreKit Configuration: None, pick"
  warn "  $proj_dir/FeralTravels.storekit there once — the path above is the"
  warn "  standard layout but has not been proven by a launch on this machine."
}

# ───────────────────────────────────────────────────────────────────────────
# xcode — the only way to actually complete a purchase on this machine
# ───────────────────────────────────────────────────────────────────────────
#
# Maestro cannot do this (see the note on `storekit`), so driving the purchase
# sheet is a human job: open the workspace, press Run, sign in, tap a price.
# Apple's transaction inspector is Debug -> StoreKit -> Manage Transactions,
# which is where you cancel, refund and expire the test subscription.
xcode() {
  storekit
  say "Opening the workspace"
  printf '  Press Run. The local store is already selected in the scheme.\n'
  printf '  Prices still need a RevenueCat offering and an appl_ key in the build\n'
  printf '  — see docs/design/iap-setup.md section 5.\n'
  open mobile/ios/FeralTravels.xcworkspace
}

install_app() {
  # An explicit device wins. `screenshots` needs a SPECIFIC model — the pixel
  # dimensions are the deliverable — while every test flow wants whatever
  # iPhone is newest, which is what pick-ios-simulator.mjs answers and why it
  # deliberately pins nothing.
  local udid label
  if [ -n "${1:-}" ]; then
    udid="$1"; label="${2:-$1}"
  else
    read -r udid label < <(node scripts/pick-ios-simulator.mjs)
  fi
  say "Booting $label"
  xcrun simctl shutdown all >/dev/null 2>&1 || true

  # ── The software keyboard has to actually exist ─────────────────────────
  #
  # A simulator defaults to "Connect Hardware Keyboard", which means focusing a
  # text field raises NO on-screen keyboard — the Mac's keyboard stands in for
  # it. The field still focuses and text still types, so nothing looks wrong,
  # and `chat-keyboard.yaml` fails on the one thing it exists to check: with no
  # keyboard there is no `keyboardWillShow`, the bottom nav never unmounts, and
  # the flow's "the nav is gone, so the keyboard opened" gate is false. The
  # screenshot shows a composer with a blinking caret and no keyboard under it.
  #
  # BEFORE the boot, both globally and per-device. The device reads this when it
  # comes up: setting it on an already-booted simulator changes nothing, which
  # is a confusing half hour if you do it in that order.
  defaults write com.apple.iphonesimulator ConnectHardwareKeyboard -bool false 2>/dev/null || true
  local simplist="$HOME/Library/Preferences/com.apple.iphonesimulator.plist"
  /usr/libexec/PlistBuddy -c "Add :DevicePreferences:$udid:ConnectHardwareKeyboard bool false" "$simplist" 2>/dev/null \
    || /usr/libexec/PlistBuddy -c "Set :DevicePreferences:$udid:ConnectHardwareKeyboard false" "$simplist" 2>/dev/null || true

  xcrun simctl boot "$udid" >/dev/null 2>&1 || true
  xcrun simctl bootstatus "$udid" -b
  open -a Simulator --args -CurrentDeviceUDID "$udid" || true
  xcrun simctl install "$udid" mobile/ios-build/*.app
  echo "$udid" > "$OUT/device.udid"
  ok "installed on $udid"
}

device_id() {
  if [ -f "$OUT/device.udid" ]; then cat "$OUT/device.udid"; else
    local udid label; read -r udid label < <(node scripts/pick-ios-simulator.mjs); echo "$udid"
  fi
}

# ───────────────────────────────────────────────────────────────────────────
# run — one flow, with everything it produced left on disk
# ───────────────────────────────────────────────────────────────────────────
run_flow() {
  local flow="${1:-chat-keyboard}"
  local file="mobile/maestro/${flow%.yaml}.yaml"
  [ -f "$file" ] || die "No such flow: $file"

  # `launch` is the HARNESS check and must not need the server to be healthy —
  # otherwise a broken backend reds layer 1 and the first line of output blames
  # the simulator. It signs in as nobody and asserts only that the app renders.
  EMAIL=""
  if [ "${flow%.yaml}" != "launch" ]; then
    say "Minting a fixture account"
    E2E_BASE_URL="$API_URL" node scripts/ios-e2e-fixture.mjs \
      --base-url "$API_URL" \
      --trip-name "$TRIP_NAME" \
      --vehicle-name "$VEHICLE_NAME" \
      --user-name "$USER_NAME" \
      ${RANGE_KM:+--range-km "$RANGE_KM"} >"$OUT/fixture.env" \
      || die "Could not mint a fixture — is the server up? see $OUT/server.log"
    # Read it line by line rather than `.`-sourcing it.
    #
    # The file is GITHUB_ENV format — bare `KEY=value`, no quoting — because CI
    # does `cat fixture.env >> "$GITHUB_ENV"` and GitHub treats quotes as part
    # of the value. So the producer CANNOT quote, and sourcing a file whose
    # default `TRIP_NAME=E2E Fixture Trip` contains spaces makes bash try to
    # run `Fixture` as a command: "line 2: Fixture: command not found", which
    # aborts the run with exit 127 before a single flow starts.
    while IFS='=' read -r __k __v; do
      [ -n "$__k" ] || continue
      case "$__k" in \#*) continue ;; esac
      export "$__k=$__v"
    done < "$OUT/fixture.env"
    ok "$EMAIL"
  fi

  local udid; udid="$(device_id)"
  rm -rf "$OUT/maestro"
  say "Running $flow on $udid"
  set +e
  MAESTRO_DRIVER_STARTUP_TIMEOUT=240000 \
  # BASE_URL and TEST_SECRET are for read-otp.js, which fetches the sign-in
  # code itself rather than trusting one minted before the run. TEST_SECRET is
  # empty locally — there is nothing to lock out — and the script omits the
  # header when it is.
  maestro --device "$udid" test "$file" \
    -e APP_ID="$APP_ID" \
    -e EMAIL="$EMAIL" \
    -e BASE_URL="$API_URL" \
    -e TEST_SECRET="${E2E_TEST_ENDPOINTS_SECRET:-}" \
    -e TRIP_NAME="$TRIP_NAME" \
    --format junit \
    --output "$OUT/report.xml" \
    --debug-output "$OUT/maestro" \
    2>&1 | tee "$OUT/flow.log"
  local status=${PIPESTATUS[0]}
  set -e

  # THE POINT OF THE WHOLE SCRIPT. Maestro's own summary line names the flow and
  # nothing else; the step it died on, the screenshot of that screen, and the
  # view hierarchy at that moment are all in the debug output, which is under a
  # DOTTED directory and therefore invisible to `ls` and skipped by GitHub's
  # upload-artifact unless asked for. Print the map so nobody has to know that.
  say "Artifacts"
  printf '  report      %s\n' "$OUT/report.xml"
  printf '  flow log    %s\n' "$OUT/flow.log"
  printf '  server log  %s\n' "$OUT/server.log"
  find "$OUT/maestro" -type f 2>/dev/null | sed 's/^/  debug       /' | head -40

  if [ $status -ne 0 ]; then
    printf '\n'
    say "Where it died"
    # commands-*.json records every step and its status — this is the file that
    # answers "which line of the yaml", which the JUnit's "Unknown error" does not.
    find "$OUT/maestro" -name 'commands-*.json' -exec tail -c 4000 {} \; 2>/dev/null || true
    printf '\n'
    find "$OUT/maestro" -name 'maestro.log' -exec tail -60 {} \; 2>/dev/null || true
    die "$flow failed (exit $status)"
  fi
  ok "$flow passed"
}

# ───────────────────────────────────────────────────────────────────────────
# screenshots — the App Store set, walked rather than photographed by hand
# ───────────────────────────────────────────────────────────────────────────
#
# `scripts/ios-e2e-local.sh screenshots [size]`   (default size: 6.9)
#
# Produces mobile/screenshots/<size>/NN-name.png, overwriting the previous set.
# Committed, because the alternative — Cmd-S into ~/Desktop — leaves five PNGs
# with no record of which build, which account or which trip made them, so the
# next release either ships these ones again or spends the afternoon again.
#
# WHAT IT DOES DIFFERENTLY FROM A TEST RUN, and why each one:
#
#  - A PINNED DEVICE MODEL. Everywhere else this script takes whatever iPhone
#    is newest, because naming one is how a job breaks the month the runner
#    drops it. Here the model IS the requirement: App Store Connect rejects an
#    image that is not one of the dimensions it expects for the slot. See
#    scripts/pick-screenshot-simulator.mjs.
#  - PRESENTABLE NAMES on the same canonical graph. Paris → Strasbourg →
#    Stuttgart with real coordinates and real road geometry is already what the
#    fixture seeds; only "E2E Fixture Trip" had to go.
#  - EVERY PNG IS MEASURED before it is kept. A set that is silently 1206x2622
#    (an iPhone 17 Pro — the 6.3" device that §3 of the listing doc wrongly
#    names for the 6.9" slot) is a set you find out about at upload.
#
# It does NOT run `doctor`, deliberately: the machine checks are about running
# flows, and a failure here should name the screenshot step.
screenshots() {
  local size="${1:-6.9}"

  command -v sips >/dev/null || die "No sips — it ships with macOS and this needs it to measure the PNGs."

  local udid want_w want_h model
  if ! read -r udid want_w want_h model < <(node scripts/pick-screenshot-simulator.mjs "$size"); then
    die "No simulator for the $size-inch slot — the line above says how to create one."
  fi
  say "$size-inch slot: $model ($udid), expecting ${want_w}x${want_h}"

  # A NAME A CUSTOMER COULD READ. Same two legs, same coordinates, same
  # geometry — sign-in.yaml and screenshots.yaml both match the card against
  # ${TRIP_NAME}, so these three and the seed move together.
  TRIP_NAME="Paris to Stuttgart"
  VEHICLE_NAME="The Hilux"
  USER_NAME="Sam"
  # 300 km against a 489 km day 1: Finn must place a stop, and must attach the
  # reason. That is the picture. See RANGE_KM above.
  RANGE_KM="300"

  up
  [ -d mobile/ios-build ] && [ -n "$(ls -d mobile/ios-build/*.app 2>/dev/null)" ] || build
  install_app "$udid" "$model"

  run_flow screenshots

  # ── Measure, then keep ───────────────────────────────────────────────────
  #
  # Every image in one App Store slot must share one size; a mixed set is a
  # rejected upload. `sips` is the arbiter rather than the device name, because
  # the device the flow ACTUALLY ran on is the only thing that decides.
  local dest="$SHOT_ROOT/$size"
  rm -rf "$dest"; mkdir -p "$dest"

  # Maestro chose where these went, not us — see MAESTRO_SHOT_GLOB. There is
  # exactly one `tests/<timestamp>` directory because run_flow wipes
  # "$OUT/maestro" before every run.
  local stage
  stage="$(find "$OUT/maestro"/$MAESTRO_SHOT_GLOB -type d -maxdepth 0 2>/dev/null | head -1)"
  [ -n "$stage" ] && [ -n "$(ls "$stage"/*.png 2>/dev/null)" ] || die \
    "The flow passed and produced no named PNG. Maestro sandboxes takeScreenshot to its own output folder, so the names in screenshots.yaml must be BARE (01-trips, not a path). Looked under $OUT/maestro/$MAESTRO_SHOT_GLOB."

  local kept=0 shot w h
  for shot in "$stage"/*.png; do
    w="$(sips -g pixelWidth  "$shot" | awk '/pixelWidth/  {print $2}')"
    h="$(sips -g pixelHeight "$shot" | awk '/pixelHeight/ {print $2}')"
    if [ "$w" != "$want_w" ] || [ "$h" != "$want_h" ]; then
      warn "$(basename "$shot") is ${w}x${h}, expected ${want_w}x${want_h}"
      die "Wrong dimensions for the $size-inch slot. The flow ran on the wrong device, or Apple accepts a second pair for this slot that pick-screenshot-simulator.mjs does not list."
    fi
    cp "$shot" "$dest/$(basename "$shot")"
    kept=$((kept + 1))
  done

  ok "$kept screenshots at ${want_w}x${want_h} in $dest"
  printf "\n"
  ls -1 "$dest" | sed 's/^/  /'
  printf "\n"
  # THE STEP THAT IS NOT AUTOMATED, said out loud. Nothing in this script can
  # tell a good screenshot from a grey rectangle where a map should be, and
  # these go on a public store listing.
  warn "LOOK AT EVERY ONE before uploading. This proves they are the right size,"
  warn "  not that they are worth showing anybody — a map that never loaded its"
  warn "  tiles and a map that did are the same number of pixels."
}

hierarchy() {
  local udid; udid="$(device_id)"
  say "Dumping the view hierarchy of whatever is on screen"
  maestro --device "$udid" hierarchy > "$OUT/hierarchy.json"
  ok "$OUT/hierarchy.json ($(wc -l < "$OUT/hierarchy.json") lines)"
  printf '  Use this to fix a selector from what the app ACTUALLY renders,\n'
  printf '  rather than from what the source suggests it renders.\n'
}

down() {
  if [ -f "$OUT/server.pid" ]; then kill "$(cat "$OUT/server.pid")" 2>/dev/null || true; rm -f "$OUT/server.pid"; fi
  case "$(db_mode)" in
    docker) docker compose -f docker-compose.e2e.yml down ;;
    local)  "$PG_LOCAL_BIN/pg_ctl" -D "$PG_LOCAL_DATA" -w stop >/dev/null 2>&1 || true ;;
  esac
  ok "server and database stopped"
}

case "${1:-all}" in
  doctor)    doctor ;;
  up)        doctor; up ;;
  build)     doctor; build ;;
  install)   install_app ;;
  run)       run_flow "${2:-chat-keyboard}" ;;
  hierarchy) hierarchy ;;
  screenshots) screenshots "${2:-6.9}" ;;
  studio)    maestro --device "$(device_id)" studio ;;
  storekit)  storekit ;;
  xcode)     xcode ;;
  down)      down ;;
  reset)
    down
    docker volume rm feraltravels-e2e-pgdata 2>/dev/null || true
    [ -d "$PG_LOCAL_DATA" ] && rm -rf "$PG_LOCAL_DATA"
    ok "database dropped"
    ;;
  all)
    doctor
    up
    [ -d mobile/ios-build ] && [ -n "$(ls -d mobile/ios-build/*.app 2>/dev/null)" ] || build
    install_app
    say "Layer 1 — harness"   ; run_flow launch
    say "Layer 2 — wiring"    ; run_flow sign-in
    say "Layer 3 — behaviour" ; run_flow chat-keyboard
    # Also layer 3, and deliberately LAST: it spends the iOS location dialog
    # for the install, and `canAskAgain` does not come back. Anything that
    # needs a fresh "never asked" state has to run before it.
    say "Layer 3 — permissions"; run_flow settings-location
    ;;
  *) die "unknown command: $1 (see the header of this file)" ;;
esac
