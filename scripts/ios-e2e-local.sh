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
#   3. BEHAVIOUR — the thing under test. `chat-keyboard.yaml`.
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
APP_ID="com.feraltravels.app"
MAESTRO_PIN="2.10.0"
# The toolchain Maestro's PREBUILT iOS driver was built with. Not a preference:
# an older xcodebuild cannot run its .xctestrun, and the only symptom is
# "iOS driver not ready in time", which sounds like a slow machine. Kept in step
# with the same constant in .github/workflows/ci.yml.
XCODE_APP="${E2E_XCODE_APP:-/Applications/Xcode_26.2.app}"

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
# NOT `grep '^KEY=' .env`. Next loads `.env.local` AHEAD of `.env`, and the
# Vercel CLI writes a `.env.local` listing every key with an EMPTY value — so a
# repo with a perfectly good ANTHROPIC_API_KEY in `.env` runs a server that has
# none. That is not hypothetical: it is why `/api/trip/replan` answered 503 to
# every send while chat-keyboard.yaml went green, and why the log filled with
# `MissingSecret` from an AUTH_SECRET that the doctor had just declared present.
#
# So resolve it the way Next does — an exported value first, then `.env.local`,
# then `.env` — but skip EMPTY assignments, which is the entire point. The
# doctor checks this, and `up` passes the result explicitly into the server's
# environment, where it outranks every file.
env_value() {
  local key="$1" v f
  v="$(printenv "$key" 2>/dev/null || true)"
  if [ -n "$v" ]; then printf '%s' "$v"; return; fi
  for f in .env.local .env; do
    [ -f "$f" ] || continue
    # Last assignment in the file wins, matching dotenv. Strips one layer of
    # surrounding quotes and an `export ` prefix.
    v="$(awk -v k="$key" '
      { line = $0; sub(/^[[:space:]]*export[[:space:]]+/, "", line) }
      index(line, k "=") == 1 {
        val = substr(line, length(k) + 2)
        sub(/^"/, "", val); sub(/"$/, "", val)
        sub(/^'"'"'/, "", val); sub(/'"'"'$/, "", val)
        out = val
      }
      END { print out }
    ' "$f")"
    if [ -n "$v" ]; then printf '%s' "$v"; return; fi
  done
  printf ''
}

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
      ok "postgres on 55432 (local cluster)"
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
  install_app
}

install_app() {
  local udid label
  read -r udid label < <(node scripts/pick-ios-simulator.mjs)
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
  EMAIL="" ; CODE=""
  if [ "${flow%.yaml}" != "launch" ]; then
    say "Minting a fixture account"
    E2E_BASE_URL="$API_URL" node scripts/ios-e2e-fixture.mjs --base-url "$API_URL" >"$OUT/fixture.env" \
      || die "Could not mint a fixture — is the server up? see $OUT/server.log"
    # shellcheck disable=SC1090
    set -a; . "$OUT/fixture.env"; set +a
    ok "$EMAIL"
  fi

  local udid; udid="$(device_id)"
  rm -rf "$OUT/maestro"
  say "Running $flow on $udid"
  set +e
  MAESTRO_DRIVER_STARTUP_TIMEOUT=240000 \
  maestro --device "$udid" test "$file" \
    -e APP_ID="$APP_ID" \
    -e EMAIL="$EMAIL" \
    -e CODE="$CODE" \
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
  studio)    maestro --device "$(device_id)" studio ;;
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
    ;;
  *) die "unknown command: $1 (see the header of this file)" ;;
esac
