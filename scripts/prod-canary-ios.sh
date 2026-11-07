#!/usr/bin/env bash
# prod-canary-ios — the simulator half of the production canary
# (docs/design/prod-canary.md). The API half is scripts/prod-canary.mjs.
#
# Builds the app from origin/main with the API pointed at PRODUCTION, signs in
# on a simulator as samuelashirley+canary-ios@gmail.com through the real email
# code, plans Girona → Barcelona through onboarding, checks the itinerary and
# the map, and deletes the trip. Flows: mobile/maestro/prod-canary/.
#
# WHO RUNS WHAT. Nothing here can read Gmail, and the Claude scheduled task
# cannot run Xcode (its shell on this Mac is a Linux VM). So they meet in files:
#
#   launchd  → `build` at :10, `run` at :40 (installed by `install`)
#   run      → asks for a code, writes tmp/prod-canary-ios/run/need-code, waits
#   Claude   → (scheduled task, :43) reads the code from Gmail, writes run/code
#   run      → types it, plans the trip, writes run/result.json
#   Claude   → reads result.json; pushes to your phone only if it failed, or if
#              need-code never appeared (the Mac was asleep or the job broke)
#
# USAGE (on the Mac):
#   bash scripts/prod-canary-ios.sh install     # launchd jobs, 12:10/12:40 and 21:10/21:40
#   bash scripts/prod-canary-ios.sh uninstall
#   bash scripts/prod-canary-ios.sh build       # what launchd runs at :10
#   bash scripts/prod-canary-ios.sh run         # what launchd runs at :40
#   bash scripts/prod-canary-ios.sh run --code-from-prompt   # by hand: type the code yourself
#   CANARY_REF=feat/prod-canary bash scripts/prod-canary-ios.sh build   # before the PR is merged
set -euo pipefail

REPO="$(git -C "$(dirname "$0")" worktree list --porcelain | awk '/^worktree /{print $2; exit}')"
SRC="$REPO/tmp/canary-ios-src"          # a worktree of origin/main, never your checkout
STATE="$REPO/tmp/prod-canary-ios"
RUN="$STATE/run"
LOGS="$STATE/logs"
APP_ID="com.feraltravels.ios"
EMAIL="samuelashirley+canary-ios@gmail.com"
API_URL="https://www.feraltravels.com"
REF="${CANARY_REF:-origin/main}"
CODE_WAIT_SECS="${CANARY_CODE_WAIT_SECS:-900}"
LABEL_PREFIX="com.feraltravels.prod-canary-ios"
mkdir -p "$STATE" "$LOGS"

say() { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }
die() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
stamp() { date -u +%Y-%m-%dT%H:%M:%SZ; }

write_result() { # ok step detail
  local sha; sha="$(cat "$STATE/built-sha" 2>/dev/null || echo unknown)"
  node -e '
    const [ok, step, detail, sha, finished, logDir] = process.argv.slice(1);
    require("fs").writeFileSync(process.env.OUT, JSON.stringify({ ok: ok === "true", step, detail, sha, finished, logDir }, null, 2));
  ' "$1" "$2" "$3" "$sha" "$(stamp)" "${LOG_DIR:-}" 
}

sync_src() {
  say "Syncing $SRC to $REF"
  git -C "$REPO" fetch --quiet origin
  local sha; sha="$(git -C "$REPO" rev-parse "$REF^{commit}")"
  if [ ! -d "$SRC/.git" ] && [ ! -f "$SRC/.git" ]; then
    git -C "$REPO" worktree add --detach "$SRC" "$sha" >/dev/null
  else
    git -C "$SRC" checkout --quiet --detach --force "$sha"
  fi
  # launchd runs $STATE/runner.sh, a COPY, never a file inside $SRC: the
  # checkout above rewrites $SRC, and bash reads a running script as it goes.
  # mv is atomic, so a run already executing keeps reading its old inode.
  if [ -f "$SRC/scripts/prod-canary-ios.sh" ]; then
    cp "$SRC/scripts/prod-canary-ios.sh" "$STATE/runner.sh.tmp" && mv -f "$STATE/runner.sh.tmp" "$STATE/runner.sh"
  fi
  echo "$sha"
}

cmd_build() {
  local sha; sha="$(sync_src | tail -1)"
  if [ "$(cat "$STATE/built-sha" 2>/dev/null)" = "$sha" ] && ls -d "$STATE"/app/*.app >/dev/null 2>&1; then
    echo "Already built at $sha."; return 0
  fi
  local log="$LOGS/build-$(date +%Y%m%d-%H%M).log"
  say "Building $sha for the simulator against $API_URL (log: $log)"
  (
    set -euo pipefail
    # The keys that decide what the binary IS, resolved from YOUR .env exactly
    # as ios-e2e-local.sh's build() does (its header explains each).
    cd "$REPO"
    # shellcheck source=lib/env-value.sh
    . "$SRC/scripts/lib/env-value.sh"
    rc_key="$(env_value EXPO_PUBLIC_REVENUECAT_IOS_KEY)"
    apple_signin="$(env_value EXPO_PUBLIC_ENABLE_APPLE_SIGNIN)"
    cd "$SRC"
    lock="$(shasum package-lock.json mobile/package-lock.json 2>/dev/null | shasum | cut -c1-12)"
    if [ "$(cat "$STATE/deps-hash" 2>/dev/null)" != "$lock" ] || [ ! -d node_modules ] || [ ! -d mobile/node_modules ]; then
      npm ci --no-audit --no-fund
      (cd mobile && npm ci --no-audit --no-fund)
      echo "$lock" > "$STATE/deps-hash"
    fi
    cd mobile
    export EXPO_PUBLIC_API_URL="$API_URL"
    [ -n "$rc_key" ] && export EXPO_PUBLIC_REVENUECAT_IOS_KEY="$rc_key"
    [ "$apple_signin" = "1" ] && export EXPO_PUBLIC_ENABLE_APPLE_SIGNIN=1
    npx expo prebuild --platform ios --clean
    workspace="$(ls -d ios/*.xcworkspace | head -1)"
    scheme="$(basename "$workspace" .xcworkspace)"
    # Release, signed ad hoc — ios-e2e-local.sh says why Debug and
    # CODE_SIGNING_ALLOWED=NO both cannot work.
    xcodebuild -workspace "$workspace" -scheme "$scheme" -configuration Release \
      -sdk iphonesimulator -derivedDataPath ios/build
    rm -rf "$STATE/app" && mkdir -p "$STATE/app"
    cp -R ios/build/Build/Products/Release-iphonesimulator/*.app "$STATE/app/"
  ) >"$log" 2>&1 || { tail -40 "$log"; echo "build-failed $sha" > "$STATE/build-status"; die "Build failed — $log"; }
  echo "$sha" > "$STATE/built-sha"
  echo "ok $sha" > "$STATE/build-status"
  echo "Built $(ls -d "$STATE"/app/*.app)."
}

boot_sim() {
  local udid label
  read -r udid label < <(node "$SRC/scripts/pick-ios-simulator.mjs") || die "No usable iPhone simulator."
  # Software keyboard on, BEFORE boot (ios-e2e-local.sh install_app explains).
  defaults write com.apple.iphonesimulator ConnectHardwareKeyboard -bool false 2>/dev/null || true
  local plist="$HOME/Library/Preferences/com.apple.iphonesimulator.plist"
  /usr/libexec/PlistBuddy -c "Add :DevicePreferences:$udid:ConnectHardwareKeyboard bool false" "$plist" 2>/dev/null \
    || /usr/libexec/PlistBuddy -c "Set :DevicePreferences:$udid:ConnectHardwareKeyboard false" "$plist" 2>/dev/null || true
  xcrun simctl boot "$udid" >/dev/null 2>&1 || true
  xcrun simctl bootstatus "$udid" -b >/dev/null
  open -a Simulator --args -CurrentDeviceUDID "$udid" || true
  xcrun simctl install "$udid" "$STATE"/app/*.app
  xcrun simctl privacy "$udid" reset location "$APP_ID" >/dev/null 2>&1 || true
  echo "$udid"
}

maestro_flow() { # name udid [extra -e args…]
  local name="$1" udid="$2"; shift 2
  MAESTRO_DRIVER_STARTUP_TIMEOUT=240000 maestro --device "$udid" test \
    "$SRC/mobile/maestro/prod-canary/$name.yaml" \
    -e APP_ID="$APP_ID" "$@" \
    --debug-output "$LOG_DIR/$name" >"$LOG_DIR/$name.log" 2>&1
}

cmd_run() {
  local prompt_code=false
  [ "${1:-}" = "--code-from-prompt" ] && prompt_code=true
  rm -rf "$RUN"; mkdir -p "$RUN"
  export OUT="$RUN/result.json"
  LOG_DIR="$LOGS/run-$(date +%Y%m%d-%H%M)"; mkdir -p "$LOG_DIR"
  echo "$(stamp)" > "$RUN/started"

  if ! ls -d "$STATE"/app/*.app >/dev/null 2>&1; then
    cmd_build >>"$LOG_DIR/build.log" 2>&1 || { write_result false build "no app and the build failed — $(tail -5 "$LOG_DIR/build.log" | tr '\n' ' ')"; exit 1; }
  fi
  [ -d "$SRC/mobile/maestro/prod-canary" ] || { write_result false setup "$SRC has no mobile/maestro/prod-canary at $(cat "$STATE/built-sha" 2>/dev/null) — is the PR merged? (or CANARY_REF)"; exit 1; }

  local udid
  udid="$(boot_sim 2>"$LOG_DIR/boot.log")" || { write_result false boot "$(tail -5 "$LOG_DIR/boot.log" | tr '\n' ' ')"; exit 1; }

  say "Requesting a code for $EMAIL"
  if ! maestro_flow request-code "$udid" -e EMAIL="$EMAIL"; then
    write_result false request-code "$(grep -E 'FAILED|Assertion|Error' "$LOG_DIR/request-code.log" | head -3 | tr '\n' ' ')"; exit 1
  fi
  stamp > "$RUN/need-code"

  local code=""
  if $prompt_code; then
    read -r -p "6-digit code from Gmail: " code
  else
    say "Waiting up to ${CODE_WAIT_SECS}s for $RUN/code"
    local waited=0
    while [ $waited -lt "$CODE_WAIT_SECS" ]; do
      if [ -s "$RUN/code" ]; then code="$(tr -dc 0-9 < "$RUN/code")"; rm -f "$RUN/code"; break; fi
      sleep 5; waited=$((waited + 5))
    done
  fi
  [[ "$code" =~ ^[0-9]{6}$ ]] || { write_result false code "no 6-digit code arrived in ${CODE_WAIT_SECS}s (the Claude task reads it from Gmail)"; exit 1; }

  say "Planning Girona → Barcelona on production"
  if ! maestro_flow plan-trip "$udid" -e CODE="$code"; then
    write_result false plan-trip "$(grep -E 'FAILED|Assertion|Error' "$LOG_DIR/plan-trip.log" | head -3 | tr '\n' ' ')"; exit 1
  fi
  write_result true done "signed in, planned Girona → Barcelona with a Google fuel stop, map drew, trips deleted"
  say "Healthy."
}

plist_for() { # job hour1 hour2 minute
  local job="$1" h1="$2" h2="$3" m="$4"
  cat <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL_PREFIX.$job</string>
  <key>ProgramArguments</key><array>
    <string>/bin/bash</string><string>$STATE/runner.sh</string><string>$job</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>$PATH</string>
    <key>HOME</key><string>$HOME</string>
    <key>JAVA_HOME</key><string>${JAVA_HOME:-}</string>
    <key>CANARY_REF</key><string>$REF</string>
  </dict>
  <key>StartCalendarInterval</key><array>
    <dict><key>Hour</key><integer>$h1</integer><key>Minute</key><integer>$m</integer></dict>
    <dict><key>Hour</key><integer>$h2</integer><key>Minute</key><integer>$m</integer></dict>
  </array>
  <key>StandardOutPath</key><string>$LOGS/launchd-$job.log</string>
  <key>StandardErrorPath</key><string>$LOGS/launchd-$job.log</string>
</dict></plist>
PLIST
}

cmd_install() {
  [ "$(uname)" = "Darwin" ] || die "Run this on the Mac."
  for tool in xcrun maestro node git; do command -v "$tool" >/dev/null || die "No $tool on PATH (the launchd jobs inherit this shell's PATH)."; done
  sync_src >/dev/null
  [ -f "$STATE/runner.sh" ] || cp "$0" "$STATE/runner.sh"
  local dir="$HOME/Library/LaunchAgents"; mkdir -p "$dir"
  for job in build run; do
    local m=10; [ "$job" = run ] && m=40
    plist_for "$job" 12 21 "$m" > "$dir/$LABEL_PREFIX.$job.plist"
    launchctl bootout "gui/$(id -u)/$LABEL_PREFIX.$job" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$dir/$LABEL_PREFIX.$job.plist"
  done
  echo "Installed: build at 12:10 and 21:10, run at 12:40 and 21:40 (local time), ref $REF."
  echo "The Claude scheduled task fires at 12:43 and 21:43 to supply the code and report."
  read -r -p "Build now, so the first run does not wait on a cold build? [Y/n] " go
  if [ "${go:-Y}" != "n" ] && [ "${go:-Y}" != "N" ]; then cmd_build; fi
}

cmd_uninstall() {
  for job in build run; do
    launchctl bootout "gui/$(id -u)/$LABEL_PREFIX.$job" 2>/dev/null || true
    rm -f "$HOME/Library/LaunchAgents/$LABEL_PREFIX.$job.plist"
  done
  echo "Removed the launchd jobs. $STATE and $SRC are left; delete them by hand if you want the space back."
}

case "${1:-}" in
  build) cmd_build ;;
  run) shift; cmd_run "$@" ;;
  install) cmd_install ;;
  uninstall) cmd_uninstall ;;
  *) sed -n '2,27p' "$0"; exit 2 ;;
esac
