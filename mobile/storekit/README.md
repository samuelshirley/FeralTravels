# The local StoreKit store

`FeralTravels.storekit` is an Xcode **StoreKit configuration file**: a fake App
Store that lives in this repo and runs inside the simulator. With it selected in
the scheme, `SKProduct` lookups resolve from this JSON instead of from Apple, so
the whole purchase sheet — prices, Apple's confirmation dialog, cancel,
Ask to Buy, accelerated renewals — can be exercised **without an App Store
Connect round trip and without a sandbox Apple Account**.

It exists for the same reason `scripts/ios-e2e-local.sh` exists: a loop that
needs a thirty-minute external system is a loop nobody runs.

## What it does and does not remove

| | Needed to see a price in the simulator? |
|---|---|
| Paid Applications Agreement Active | **No**, with this file |
| Products created in App Store Connect | **No**, with this file |
| A sandbox Apple Account | **No**, with this file |
| A RevenueCat project + offering | **Yes, still** |
| `EXPO_PUBLIC_REVENUECAT_IOS_KEY` in the build | **Yes, still** |

That second half is the part people get wrong. The app does not ask StoreKit for
products directly — it asks **RevenueCat** for an Offering, and RevenueCat then
looks each product up through StoreKit. This file satisfies the second step, not
the first. With no RevenueCat offering there is nothing to look up and the sheet
is empty regardless of what is in here.

So the honest description is: this removes Apple's paperwork from the loop, and
leaves RevenueCat's dashboard in it. Section 5 of `docs/design/iap-setup.md` is
still required before any of this shows a price.

## Keeping it honest

`productID` must match `PRODUCTS` in `src/server/payments/constants.ts`
**character for character**, and `displayPrice` should match `priceUsd`. A
mismatch here does not fail — it produces the same empty offering a real
mismatch produces, which is the failure this file is supposed to help diagnose
rather than imitate.

`_timeRate` is `oneRenewalEveryTwoMinutes`, so a monthly subscription renews
every two minutes and the whole lifecycle — renew, cancel, expire — happens
inside one sitting. That is the point of testing here rather than in sandbox.

`_askToBuyEnabled` is **off** by default. Turn it on in Xcode (Editor → Enable
Ask To Buy) to exercise the deferred path: the purchase resolves as
`PAYMENT_PENDING_ERROR`, which the app must treat as *waiting for approval*, not
as a failure. That branch is `pending` in `src/lib/purchaseOutcome.ts` and it is
worth actually seeing once.

## Why the tracked copy is here and not in `mobile/ios/`

`mobile/ios/` is gitignored — it is CNG output that `expo prebuild` regenerates
from scratch, `--clean` included, so anything kept in there is deleted by the
next build. The source of truth therefore lives here.

`scripts/ios-e2e-local.sh storekit` then, **after** prebuild, copies it to
`mobile/ios/FeralTravels.storekit` and writes a
`<StoreKitConfigurationFileReference identifier = "../FeralTravels.storekit">`
into both the Launch and Test actions of the generated scheme. It is idempotent
and runs as part of `build`.

The copy exists because the scheme's `identifier` is a path relative to the
`.xcodeproj` bundle, and a file sitting directly beside it is the layout Xcode
writes itself — the shape least likely to be wrong. **That path has not been
proven by an actual launch on this machine**, only by the scheme still parsing:
if Xcode's scheme editor (Product → Scheme → Edit Scheme → Run → Options) shows
*StoreKit Configuration: None*, select `mobile/ios/FeralTravels.storekit` there
once. The script prints that reminder every time it runs.

## Using it

```bash
scripts/ios-e2e-local.sh build      # prebuild, inject, compile, install
scripts/ios-e2e-local.sh xcode      # open the workspace, then press Run
```

**A purchase must be driven from Xcode's Run, not from a Maestro flow.** The
StoreKit configuration is activated by the scheme's launch action; Maestro
installs the `.app` with `simctl install` and launches it outside any scheme, so
the flows do not see this store and never will until Apple ships a `simctl`
equivalent (there is no `simctl storekit` subcommand as of Xcode 26.6 — checked,
not assumed). That is why the Maestro flows deliberately do not attempt a
purchase, and why `chat-keyboard.yaml` remains the behaviour layer.

Apple's own transaction inspector — Xcode → Debug → StoreKit → Manage
Transactions — is where you cancel, refund and expire a test subscription.
