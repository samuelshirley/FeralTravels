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
  xver="$(xcodebuild -version | head -1 | awk '{print $2}')"
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

  command -v docker >/dev/null || die "No docker. Install Docker Desktop; the local database runs in it."
  docker info >/dev/null 2>&1 || die "Docker is installed but not running. Start Docker Desktop."
  ok "docker running"

  command -v node >/dev/null || die "No node."
  ok "node $(node -v)"

  [ -f .env ] || die "No .env — the local server still needs ANTHROPIC_API_KEY and AUTH_SECRET from it."
  grep -q '^ANTHROPIC_API_KEY=.' .env || warn "ANTHROPIC_API_KEY looks empty in .env; chat-keyboard sends a real message."
  grep -q '^AUTH_SECRET=.' .env       || die "AUTH_SECRET is empty in .env; sign-in cannot mint a session."
  ok ".env has the keys the server needs"

  local udid label
  if ! read -r udid label < <(node scripts/pick-ios-simulator.mjs); then
    die "No usable iPhone simulator. Open Xcode → Settings → Components and install an iOS runtime."
  fi
  ok "simulator: $label"
  ok "device id: $udid"

  say "Everything the run needs is present"
}

# ───────────────────────────────────────────────────────────────────────────
# up — database + schema + server, warmed
# ───────────────────────────────────────────────────────────────────────────
up() {
  say "Starting the local database"
  docker compose -f docker-compose.e2e.yml up -d --wait
  ok "postgres on 55432"

  say "Applying migrations"
  DATABASE_URL="$DB_URL" npm run db:migrate >"$OUT/migrate.log" 2>&1 \
    || { tail -30 "$OUT/migrate.log"; die "Migrations failed — see $OUT/migrate.log"; }
  ok "schema is current"

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
    DATABASE_URL="$DB_URL" \
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
    EXPO_PUBLIC_API_URL="$API_URL" npx expo prebuild --platform ios --clean
    local workspace scheme
    workspace="$(ls -d ios/*.xcworkspace | head -1)"
    scheme="$(basename "$workspace" .xcworkspace)"
    echo "API base baked into this build: $API_URL"
    xcodebuild -workspace "$workspace" \
      -scheme "$scheme" \
      -configuration Debug \
      -sdk iphonesimulator \
      -derivedDataPath ios/build \
      CODE_SIGNING_ALLOWED=NO
    mkdir -p ios-build
    rm -rf ios-build/*.app
    cp -R ios/build/Build/Products/Debug-iphonesimulator/*.app ios-build/
  ) >"$OUT/build.log" 2>&1 || { tail -40 "$OUT/build.log"; die "Build failed — see $OUT/build.log"; }
  ok "built $(ls -d mobile/ios-build/*.app | head -1)"
  install_app
}

install_app() {
  local udid label
  read -r udid label < <(node scripts/pick-ios-simulator.mjs)
  say "Booting $label"
  xcrun simctl shutdown all >/dev/null 2>&1 || true
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
  docker compose -f docker-compose.e2e.yml down
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
  reset)     down; docker volume rm feraltravels-e2e-pgdata 2>/dev/null || true; ok "volume dropped" ;;
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
