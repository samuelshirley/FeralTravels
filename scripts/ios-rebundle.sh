#!/usr/bin/env bash
# Swap a fresh JavaScript bundle into an already-compiled simulator .app.
#
#   scripts/ios-rebundle.sh <path/to/App.app> <api-url>     both halves, one machine
#   scripts/ios-rebundle.sh bundle <out-dir> <api-url>      half 1: any OS, needs mobile/node_modules
#   scripts/ios-rebundle.sh apply <out-dir> <path/to/App.app>
#                                                           half 2: macOS, needs only <out-dir>
#
# WHY THIS EXISTS. `EXPO_PUBLIC_API_URL` is inlined into the bundle at BUNDLE
# time, and CI points every build at the PR's own preview — a URL that exists
# only for that push. That is why the old `.app` cache was removed on
# 2026-08-28: a cache hit launched the simulator against a previous PR's
# torn-down preview. The native half of the app (the 13-16 minutes of
# xcodebuild) does not depend on that URL at all, so CI compiles it once,
# caches it by native fingerprint, and puts a bundle built for ITS preview
# inside it with this script.
#
# WHY TWO HALVES (2026-11-12). Every macOS shard used to run the whole thing,
# which meant every shard paid `npm ci` in mobile/ (0m31-2m46 on a macOS runner,
# plus 0m36-3m29 of setup-node's cache restore) and a Metro bundle (0m48-2m29),
# all after the preview was up — on the critical path, five times over. Now
# `bundle` runs ONCE, on Linux (`npm ci` there is ~11s), and each shard runs
# `apply`, which needs no node_modules at all: <out-dir> carries the plain JS,
# the assets, the expo-updates manifest, the API URL it was built for, and the
# macOS hermesc to compile it with. Hermes compilation stays on macOS with the
# same osx-bin hermesc the one-machine form uses, so the bytecode is made by
# the same binary on the same OS as before; the only step that moved OS is
# Metro's JS bundle, which the Mobile typecheck job already builds on Linux.
#
# What `bundle` + `apply` do is what Xcode's "Bundle React Native code and
# images" phase does, in the same order, with the same tools: `expo
# export:embed` (Expo's bundle command, the one that phase calls), Hermes
# bytecode via the hermesc that ships with the installed react-native (same
# "HBC bytecode version" as the Pods copy — both are built for the same RN
# release), the expo-updates embedded manifest, then an ad-hoc re-sign.
# `--reset-cache` is NOT optional: Metro's transform cache lives in $TMPDIR, is
# keyed without EXPO_PUBLIC_* values, and has already baked a stale localhost
# URL into a build that was told the preview's (2026-09-27).
#
# Both halves PROVE the swap: the bundle must contain the API host it was given
# and must not contain the placeholder the native build was compiled with. A
# check that cannot fail is decoration, so that one is the whole point — and
# `apply` re-runs it on the bytecode actually installed, against the URL
# recorded in <out-dir>, so a shard cannot install a bundle meant for another
# preview.
set -euo pipefail

PLACEHOLDER_HOST="${IOS_BUNDLE_PLACEHOLDER_HOST:-ios-bundle-placeholder.invalid}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MOBILE="$HERE/../mobile"
USAGE="usage: ios-rebundle.sh <App.app> <api-url> | bundle <out-dir> <api-url> | apply <out-dir> <App.app>"

# The host must be in the file and the placeholder must not be.
prove() { # <file> <api-url> <what>
  local host
  host="$(node -e "console.log(new URL(process.argv[1]).host)" "$2")"
  if ! LC_ALL=C /usr/bin/grep -a -q -F "$host" "$1"; then
    echo "ios-rebundle: the $3 does not contain $host — the app would talk to the wrong server" >&2
    exit 1
  fi
  if LC_ALL=C /usr/bin/grep -a -q -F "$PLACEHOLDER_HOST" "$1"; then
    echo "ios-rebundle: the $3 still carries the build placeholder $PLACEHOLDER_HOST" >&2
    exit 1
  fi
}

do_bundle() { # <out-dir> <api-url>
  local out api_url entry
  out="$1"; api_url="$2"
  mkdir -p "$out"
  out="$(cd "$out" && pwd)"
  rm -rf "$out/main.js" "$out/assets-root" "$out/EXUpdates.bundle" "$out/hermesc" "$out/api-url"
  mkdir -p "$out/assets-root" "$out/EXUpdates.bundle"

  cd "$MOBILE"
  # The MACOS hermesc, whatever OS this half runs on: `apply` compiles with it.
  local hermesc="node_modules/react-native/sdks/hermesc/osx-bin/hermesc"
  [ -x "$hermesc" ] || { echo "ios-rebundle: no hermesc at mobile/$hermesc (npm ci in mobile/?)" >&2; exit 1; }

  entry="$(node -e "require('expo/scripts/resolveAppEntry')" "$PWD" ios absolute | tail -n 1)"
  echo "ios-rebundle: bundling $entry for $api_url"
  # Only this variable differs from the native build; everything else EXPO_PUBLIC_*
  # comes from the environment exactly as it did there.
  EXPO_PUBLIC_API_URL="$api_url" npx expo export:embed \
    --platform ios \
    --dev false \
    --minify false \
    --reset-cache \
    --entry-file "$entry" \
    --bundle-output "$out/main.js" \
    --assets-dest "$out/assets-root"

  # The expo-updates embedded manifest lists the bundle's assets. Regenerated so it
  # describes THIS bundle rather than the one the cached native build carried.
  CONFIGURATION=Release node node_modules/expo-updates/utils/build/createUpdatesResources.js \
    ios "$PWD" "$out/EXUpdates.bundle" all "$entry"

  cp "$hermesc" "$out/hermesc"
  printf '%s\n' "$api_url" > "$out/api-url"
  prove "$out/main.js" "$api_url" "JS bundle"
  echo "ios-rebundle: bundle for $api_url written to $out"
}

do_apply() { # <out-dir> <App.app>
  local out app api_url
  out="$(cd "$1" && pwd)"
  app="$(cd "$2" && pwd)"
  [ -f "$app/Info.plist" ] || { echo "ios-rebundle: $app is not an .app bundle" >&2; exit 1; }
  [ -f "$app/main.jsbundle" ] || { echo "ios-rebundle: $app has no main.jsbundle to replace" >&2; exit 1; }
  for f in main.js hermesc api-url; do
    [ -s "$out/$f" ] || { echo "ios-rebundle: $out has no $f — was it made by 'ios-rebundle.sh bundle'?" >&2; exit 1; }
  done
  [ -x "$out/hermesc" ] || { echo "ios-rebundle: $out/hermesc is not executable (unpacked from a tarball?)" >&2; exit 1; }
  api_url="$(cat "$out/api-url")"

  "$out/hermesc" -emit-binary -max-diagnostic-width=80 -O -w \
    -out "$app/main.jsbundle" "$out/main.js"
  # Merged INTO the app, as `--assets-dest "$APP"` did: files the bundle
  # names replace their namesakes, everything else the native build put
  # there stays.
  cp -R "$out/assets-root/." "$app/"
  if [ -d "$app/EXUpdates.bundle" ]; then
    cp -R "$out/EXUpdates.bundle/." "$app/EXUpdates.bundle/"
  fi

  # Resources changed, so the seal is stale. A simulator build is signed ad hoc and
  # carries its entitlements inside the executable (the keychain group
  # expo-secure-store needs), so an ad-hoc re-sign of the bundle keeps them.
  codesign --force --sign - --timestamp=none "$app"

  prove "$app/main.jsbundle" "$api_url" "installed bundle"
  echo "ios-rebundle: ok — $(basename "$app") now talks to $(node -e "console.log(new URL(process.argv[1]).host)" "$api_url")"
}

case "${1:-}" in
  bundle)
    [ $# -eq 3 ] || { echo "$USAGE" >&2; exit 2; }
    do_bundle "$2" "$3" ;;
  apply)
    [ $# -eq 3 ] || { echo "$USAGE" >&2; exit 2; }
    do_apply "$2" "$3" ;;
  "")
    echo "$USAGE" >&2; exit 2 ;;
  *)
    [ $# -eq 2 ] || { echo "$USAGE" >&2; exit 2; }
    WORK="$(mktemp -d "${TMPDIR:-/tmp}/ios-rebundle.XXXXXX")"
    trap 'rm -rf "$WORK"' EXIT
    APP_ARG="$(cd "$1" && pwd)"
    ( do_bundle "$WORK" "$2" )
    do_apply "$WORK" "$APP_ARG" ;;
esac
