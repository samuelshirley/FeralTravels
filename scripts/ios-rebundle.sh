#!/usr/bin/env bash
# Swap a fresh JavaScript bundle into an already-compiled simulator .app.
#
#   scripts/ios-rebundle.sh <path/to/App.app> <api-url>
#
# WHY THIS EXISTS. `EXPO_PUBLIC_API_URL` is inlined into the bundle at BUNDLE
# time, and CI points every build at the PR's own preview — a URL that exists
# only for that push. That is why the old `.app` cache was removed on
# 2026-08-28: a cache hit launched the simulator against a previous PR's
# torn-down preview. The native half of the app (the 13-16 minutes of
# xcodebuild) does not depend on that URL at all, so CI now compiles it once,
# caches it by native fingerprint, and every simulator job runs this script to
# put a bundle built for ITS preview inside it.
#
# It does what Xcode's "Bundle React Native code and images" phase does, in the
# same order, with the same tools: `expo export:embed` (Expo's bundle command,
# the one that phase calls), Hermes bytecode via the hermesc that ships with the
# installed react-native (same "HBC bytecode version" as the Pods copy — both
# are built for the same RN release), the expo-updates embedded manifest, then
# an ad-hoc re-sign. `--reset-cache` is NOT optional: Metro's transform cache
# lives in $TMPDIR, is keyed without EXPO_PUBLIC_* values, and has already baked
# a stale localhost URL into a build that was told the preview's (2026-09-27).
#
# It then PROVES the swap: the new bundle must contain the API host it was given
# and must not contain the placeholder the native build was compiled with. A
# check that cannot fail is decoration, so that one is the whole point.
set -euo pipefail

APP="${1:?usage: ios-rebundle.sh <App.app> <api-url>}"
API_URL="${2:?usage: ios-rebundle.sh <App.app> <api-url>}"
PLACEHOLDER_HOST="${IOS_BUNDLE_PLACEHOLDER_HOST:-ios-bundle-placeholder.invalid}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MOBILE="$HERE/../mobile"
APP="$(cd "$APP" && pwd)"

[ -f "$APP/Info.plist" ] || { echo "ios-rebundle: $APP is not an .app bundle" >&2; exit 1; }
[ -f "$APP/main.jsbundle" ] || { echo "ios-rebundle: $APP has no main.jsbundle to replace" >&2; exit 1; }

cd "$MOBILE"
HERMESC="node_modules/react-native/sdks/hermesc/osx-bin/hermesc"
[ -x "$HERMESC" ] || { echo "ios-rebundle: no hermesc at mobile/$HERMESC (npm ci in mobile/?)" >&2; exit 1; }

ENTRY_FILE="$(node -e "require('expo/scripts/resolveAppEntry')" "$PWD" ios absolute | tail -n 1)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/ios-rebundle.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

echo "ios-rebundle: bundling $ENTRY_FILE for $API_URL"
# Only this variable differs from the native build; everything else EXPO_PUBLIC_*
# comes from the environment exactly as it did there.
EXPO_PUBLIC_API_URL="$API_URL" npx expo export:embed \
  --platform ios \
  --dev false \
  --minify false \
  --reset-cache \
  --entry-file "$ENTRY_FILE" \
  --bundle-output "$WORK/main.jsbundle" \
  --assets-dest "$APP"

"$HERMESC" -emit-binary -max-diagnostic-width=80 -O -w \
  -out "$APP/main.jsbundle" "$WORK/main.jsbundle"

# The expo-updates embedded manifest lists the bundle's assets. Regenerated so it
# describes THIS bundle rather than the one the cached native build carried.
if [ -d "$APP/EXUpdates.bundle" ]; then
  CONFIGURATION=Release node node_modules/expo-updates/utils/build/createUpdatesResources.js \
    ios "$PWD" "$APP/EXUpdates.bundle" all "$ENTRY_FILE"
fi

# Resources changed, so the seal is stale. A simulator build is signed ad hoc and
# carries its entitlements inside the executable (the keychain group
# expo-secure-store needs), so an ad-hoc re-sign of the bundle keeps them.
codesign --force --sign - --timestamp=none "$APP"

API_HOST="$(node -e "console.log(new URL(process.argv[1]).host)" "$API_URL")"
if ! LC_ALL=C /usr/bin/grep -a -q -F "$API_HOST" "$APP/main.jsbundle"; then
  echo "ios-rebundle: the new bundle does not contain $API_HOST — the app would talk to the wrong server" >&2
  exit 1
fi
if LC_ALL=C /usr/bin/grep -a -q -F "$PLACEHOLDER_HOST" "$APP/main.jsbundle"; then
  echo "ios-rebundle: the bundle still carries the build placeholder $PLACEHOLDER_HOST" >&2
  exit 1
fi
echo "ios-rebundle: ok — $(basename "$APP") now talks to $API_HOST"
