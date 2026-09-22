#!/usr/bin/env bash
#
# Ask StoreKit — directly, with no RevenueCat and no React Native in the way —
# whether the App Store will vend our two subscriptions, from the booted iOS
# simulator's SANDBOX storefront.
#
# ── Why this exists ────────────────────────────────────────────────────────
#
# The purchase sheet's `store_empty` reason means "RevenueCat served the
# offering, and StoreKit resolved none of its products". From inside the app
# that is one opaque sentence. This splits it:
#
#   - RevenueCat's half is checked with a curl against its public API (the
#     offering and its product ids, exactly as the SDK receives them);
#   - StoreKit's half is checked by a 30-line Swift app with the bundle id
#     `com.feraltravels.ios`, which asks both StoreKit 1 and StoreKit 2 for
#     PRODUCTS in src/server/payments/constants.ts and prints what came back.
#
# On 2026-09-21 this printed `SK1 valid=[] invalid=[monthly, annual]` from the
# USA storefront while RevenueCat served both packages correctly — StoreKit's
# half, i.e. App Store Connect, not code (docs/design/iap-setup.md §1).
# Re-run it after each App Store Connect change. A POSITIVE here (`SK2 resolved
# 2 of 2` with prices) is conclusive. A negative is weaker: Apple does not
# document the simulator as a sandbox witness, so if it stays invalid after
# App Store Connect is fixed, a TestFlight build on a device decides.
#
# ── What it changes ────────────────────────────────────────────────────────
#
# It INSTALLS OVER `com.feraltravels.ios` on the booted simulator (StoreKit
# resolves products by the bundle id, so the probe must wear ours). At the end
# it reinstalls mobile/ios/build/.../FeralTravels.app if one exists; otherwise
# rebuild with `scripts/ios-e2e-local.sh build`. Nothing else is touched, and
# nothing is bought.
#
# No StoreKit configuration file is involved: `simctl launch` runs outside any
# Xcode scheme, so this is Apple's sandbox, which is the question.
#
# Usage: scripts/storekit-probe.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

BUNDLE_ID="com.feraltravels.ios"
REBUILT_APP="mobile/ios/build/Build/Products/Release-iphonesimulator/FeralTravels.app"

# The product ids come from the server's own list, so a rename cannot leave
# this probe asking about the old ones. See scripts/lib/product-ids.sh.
. scripts/lib/product-ids.sh
IDS=()
while IFS= read -r id; do IDS+=("$id"); done < <(product_ids)
[ "${#IDS[@]}" -gt 0 ] || { echo "No product ids found in constants.ts" >&2; exit 1; }

# The public SDK key — public by design, it is in every build (mobile/eas.json).
RC_KEY="$(grep -oE 'appl_[A-Za-z0-9]+' mobile/eas.json | head -1)"

xcrun simctl list devices booted | grep -q Booted \
  || { echo "Boot an iOS simulator first (open -a Simulator)." >&2; exit 1; }

echo "== RevenueCat: the offering the SDK receives =="
if [ -n "$RC_KEY" ]; then
  curl -sS -H "Authorization: Bearer $RC_KEY" -H "X-Platform: ios" \
    "https://api.revenuecat.com/v1/subscribers/storekit-probe/offerings"
  echo
else
  echo "(no appl_ key in mobile/eas.json — the app would report no_key)"
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/Probe.app"

swift_ids="$(printf '"%s", ' "${IDS[@]}")"
cat > "$WORK/main.swift" <<EOF
import StoreKit
import UIKit

let ids: Set<String> = [${swift_ids%, }]
func log(_ s: String) { NSLog("SKPROBE %@", s) }

class SK1: NSObject, SKProductsRequestDelegate {
  func productsRequest(_ r: SKProductsRequest, didReceive resp: SKProductsResponse) {
    log("SK1 valid=\(resp.products.map { \$0.productIdentifier }.sorted()) invalid=\(resp.invalidProductIdentifiers.sorted())")
  }
  func request(_ r: SKRequest, didFailWithError e: Error) { log("SK1 error: \(e)") }
}
let sk1 = SK1()
let req = SKProductsRequest(productIdentifiers: ids)
req.delegate = sk1
req.start()

Task {
  if let sf = await Storefront.current { log("storefront=\(sf.countryCode)") } else { log("storefront=nil") }
  do {
    let products = try await Product.products(for: ids)
    log("SK2 resolved \(products.count) of \(ids.count): " + products.map { "\(\$0.id)=\(\$0.displayPrice)" }.joined(separator: ", "))
  } catch { log("SK2 threw: \(error)") }
  try? await Task.sleep(nanoseconds: 2_000_000_000)
  log("done")
  exit(0)
}
UIApplicationMain(CommandLine.argc, CommandLine.unsafeArgv, nil, nil)
EOF

cat > "$WORK/Probe.app/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string>
<key>CFBundleExecutable</key><string>Probe</string>
<key>CFBundleName</key><string>Probe</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>1.0</string>
<key>CFBundleVersion</key><string>1</string>
<key>MinimumOSVersion</key><string>17.0</string>
<key>UIDeviceFamily</key><array><integer>1</integer></array>
</dict></plist>
EOF

echo "== StoreKit: sandbox, booted simulator =="
xcrun -sdk iphonesimulator swiftc -target "$(uname -m)-apple-ios17.0-simulator" \
  "$WORK/main.swift" -o "$WORK/Probe.app/Probe"
codesign -s - --force "$WORK/Probe.app" >/dev/null 2>&1
xcrun simctl install booted "$WORK/Probe.app"

# --console-pty streams the probe's NSLog lines into a file; poll it for the
# probe's "done" (bounded — a hung StoreKit request is itself an answer)
# rather than breaking out of a pipe, which pipefail turns into an early exit
# that skips the reinstall below.
xcrun simctl launch --console-pty --terminate-running-process booted "$BUNDLE_ID" \
  > "$WORK/console.log" 2>&1 &
LAUNCH_PID=$!
for _ in $(seq 1 60); do
  grep -q "SKPROBE done" "$WORK/console.log" && break
  sleep 1
done
kill "$LAUNCH_PID" 2>/dev/null || true
wait "$LAUNCH_PID" 2>/dev/null || true
grep "SKPROBE" "$WORK/console.log" | sed -E 's/^.*SKPROBE /  /' || true
grep -q "SKPROBE done" "$WORK/console.log" \
  || echo "  (no answer from StoreKit within 60s)"

if [ -d "$REBUILT_APP" ]; then
  xcrun simctl install booted "$REBUILT_APP"
  echo "(reinstalled $REBUILT_APP)"
else
  echo "(the probe is still installed as $BUNDLE_ID — rebuild with scripts/ios-e2e-local.sh build)"
fi
