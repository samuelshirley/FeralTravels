# TestFlight and the Apple side, for someone who has never shipped an iOS app

This is the plain-language version. No step here is hard; the difficulty is
entirely that Apple has four different things that all sound like "publishing
the app" and they gate each other in a non-obvious order.

`docs/design/mobile-release.md` covers the pipeline's mechanics and traps.
`docs/design/revenuecat-implementation.md` covers payments. This file is the
map: what each Apple thing *is*, what it actually requires, and what you have
to go and do.

---

## What TestFlight is

TestFlight is Apple's beta distribution channel. You upload a build to App
Store Connect, name some testers, and they install the app through the
TestFlight app on their phone. It is the real binary, signed the real way,
running on real hardware — it is not a simulator or a preview.

**How it differs from the App Store:**

| | TestFlight | App Store |
|---|---|---|
| Who can install | People you invite | Anyone |
| Review | None (internal) / lightweight Beta App Review (external) | Full App Review |
| Screenshots, description, keywords | Not needed | Required |
| Age rating, privacy nutrition label | Minimal | Required |
| Build lifetime | **Expires after 90 days** | Permanent until replaced |
| Time from upload to installable | Minutes (internal) | Days, plus rejections |

The 90-day expiry matters more than it sounds: a TestFlight build is not a
release, it is a loaf of bread. If nobody merges anything for three months, the
build your testers have goes dead and they cannot reinstall it.

### Internal vs external testing

**Internal (this is what you want now):**
- Up to **100 testers**, each on up to 30 devices.
- Testers must be people with a role on your App Store Connect team — Account
  Holder, Admin, App Manager, Developer or Marketing. You add them under Users
  and Access first, then to the internal group.
- **No review at all.** A build becomes installable as soon as Apple finishes
  processing it, usually 5–15 minutes after upload.
- You can set the group to receive new builds automatically.

**External:**
- Up to **10,000 testers**, who need no relationship with your team. Invite by
  email or by a **public link** you can post anywhere.
- Requires **Beta App Review** — a lighter check than full App Review, but a
  real human looking at the build. The first build of a version needs it;
  subsequent builds of the same version usually go through without re-review.
- This is what you use when you want strangers testing, and it is the first
  time Apple looks at the app at all.

**The app record already exists.** `mobile/eas.json` pins
`appleTeamId: "TJX3F3832H"` and `ascAppId: "6802705582"` — the second of which
is the OLD account's app record and is outstanding (see the top of
`docs/design/iap-setup.md`), so there is an App
Store Connect app called Feral Travels with bundle id `com.feraltravels.ios`
sitting there waiting for a build. You are not starting from zero.

---

## What TestFlight needs vs what the App Store needs

The useful thing to internalise: **TestFlight needs almost nothing.**

**To put a build on TestFlight (internal), you need:**
- an active Apple Developer Program membership ($99/yr) — you have one;
- the app record — it exists;
- a signed build uploaded to App Store Connect — the pipeline does this;
- the export-compliance answer, which `app.config.js` already hardcodes
  (`ITSAppUsesNonExemptEncryption: false`, so App Store Connect stops asking on
  every upload);
- testers added under Users and Access.

That's it. **No screenshots. No app description. No App Review. No privacy
nutrition label. No Paid Applications Agreement. No Sign in with Apple.**

**To ship to the App Store you additionally need:**
- full App Review (expect at least one rejection — everyone gets one);
- screenshots for each required device size, description, keywords, support
  URL, marketing URL;
- age rating questionnaire and the **App Privacy** "nutrition label";
- a privacy manifest (`PrivacyInfo.xcprivacy`);
- a **demo account** for the reviewer, because the app is sign-in gated, and it
  must not hit the paywall mid-review;
- **Sign in with Apple** (see below);
- in-app purchases submitted alongside the build;
- account deletion reachable in-app — **already built** (Settings → Delete
  account, Guideline 5.1.1(v)).

**One important asterisk on the Paid Applications Agreement:** TestFlight does
not need it, but **in-app purchases do not function without it — including in
TestFlight.** StoreKit returns an empty product list, with no error, until the
agreement is Active and tax and banking are complete. So you can hand testers a
working app tomorrow, and they will see a paywall with no prices on it until
that paperwork clears. See section 1 of `revenuecat-implementation.md`.

---

## How this repo's pipeline works today

`.github/workflows/mobile.yml` runs on every push to `main` that touches
`mobile/**` (or the workflow file itself), and can be run by hand from the
Actions tab.

### The two delivery mechanisms

**`eas update` — over-the-air (OTA).** Publishes just the JavaScript bundle to
Expo's servers on a named channel (`production`). An installed app picks it up
on next launch, in seconds. No Apple involvement whatsoever — Apple explicitly
allows this for JS-only changes. It reaches only binaries whose
**`runtimeVersion`** matches; ours is `{ policy: 'appVersion' }`, so an update
published while `version` is `1.0.0` reaches `1.0.0` builds and nothing else.

**`eas build --auto-submit` — a native binary.** Runs prebuild, compiles,
signs, and uploads to App Store Connect, where it lands in TestFlight after
processing. Roughly 30 minutes of build plus 5–15 of Apple processing.

### What the workflow actually does

Every qualifying merge does **both**, in this order:

1. Fail fast if `EXPO_TOKEN` is missing.
2. Confirm the token can actually *see* this project (`eas build:list` — the
   cheapest call needing both a valid token and read access to this project).
   This exists because a token from the wrong Expo account fails everything
   with `Entity not authorized`, thirty minutes into a build.
3. **Decide whether a native input moved**, by diffing the push:

   ```
   ^mobile/(app\.config\.js|package\.json|package-lock\.json|eas\.json|assets/)
   ```

   `mobile/ios` and `mobile/android` are gitignored — EAS regenerates them — so
   they can never appear in a diff. That is why the list is the *inputs* to the
   native build rather than its output.

4. **If nothing native moved:** load the `build.production.env` block out of
   `eas.json` into the shell (because that block applies to builds only, and
   `EXPO_PUBLIC_*` values are inlined at bundle time — without this step the OTA
   ships an app with both social sign-in buttons silently removed), then
   `eas update --platform ios --channel production`.
5. **Always, native or not:** `eas build --platform ios --profile production
   --auto-submit`, and **wait for it**. A green run means the binary really is
   on App Store Connect, not merely queued.

**The one exception, and it is a safety property.** If a native input moved,
the OTA is **skipped**. A JS bundle that expects a native module the installed
binary does not carry crashes on launch, and `runtimeVersion` only protects
against that if `version` was also bumped — which is a promise kept by hand and
was broken once already (PR #7 added a URL scheme and the Apple Sign-in
entitlement without touching `version`). On those merges the binary is the only
safe delivery.

This is directly relevant to payments: adding `react-native-purchases` changes
`mobile/package.json`, which is on that list, so **that merge cuts a binary and
publishes no OTA.** Correct behaviour — and it means the paywall cannot reach
an existing install until testers update.

### Forcing a path by hand

Actions → **Mobile** → Run workflow. A manual dispatch has no base commit to
diff against, so it is treated as native: the OTA is skipped and a binary is
built. Use it to get a fresh TestFlight build for a reviewer, or after changing
an EAS credential.

### `EAS_AUTO_SUBMIT` — documented, but not in the workflow

`docs/design/mobile-release.md` describes a repo **variable** (Settings →
Secrets and variables → Actions → **Variables** tab, not Secrets) named
`EAS_AUTO_SUBMIT`, set to `true`, gating the upload to App Store Connect.

**The workflow on disk does not read it.** `mobile.yml` passes `--auto-submit`
unconditionally. Setting the variable does nothing; not setting it prevents
nothing. Treat the doc as describing an earlier design — either wire the gate
back in or drop it from the doc, but do not go hunting for a variable that
changes behaviour, because none does.

The same doc also describes the mobile jobs living inside
`.github/workflows/pipeline.yml` and running `needs: deploy`. There is no
`pipeline.yml` in `.github/workflows/` — there is `ci.yml`,
`deploy-production.yml`, `mobile.yml` and `pr-cleanup.yml`, plus untracked
`pipeline.yml.new` and `mobile-workflow.new.yml` at the repo root. So `Mobile`
is currently its own workflow triggered by the push to `main`, **not** ordered
after the web deploy. Worth knowing before an OTA reaches a phone ahead of the
API it expects.

### Credentials the pipeline needs

- **`EXPO_TOKEN`** (repo *secret*). Must belong to the Expo account that owns
  the project — `owner: 'samuelashirley'` in `app.config.js`. A token from any
  other account, including a robot user created elsewhere, fails every call.
  Two runs died on exactly this.
- **An App Store Connect API key stored on EAS**, for the upload.
  `eas credentials` → iOS → production → App Store Connect API Key. `eas.json`
  pins `ascAppId` and `appleTeamId`, but those are identifiers, not
  credentials — without the key, `--auto-submit` fails *after* a successful
  thirty-minute build. Generated at App Store Connect → Users and Access →
  Integrations → App Store Connect API, **App Manager** role, `.p8`
  downloadable once.

---

## Sign in with Apple

**Required before App Store submission. Not required for TestFlight internal
testing.**

Guideline 4.8 says that an app using a third-party or social login to establish
the user's primary account must *also* offer an equivalent login service that
limits data collection to name and email, lets the user keep their email
address private, and does not collect in-app interactions for advertising. We
offer Google sign-in, so 4.8 applies to us.

Note the guideline does not literally name Sign in with Apple — it describes
properties, and Sign in with Apple is the one option guaranteed to have them.
It is already implemented and already enabled in the production build profile
(`EXPO_PUBLIC_ENABLE_APPLE_SIGNIN=1` in `eas.json`, which flips `usesAppleSignIn`
and adds the `expo-apple-authentication` plugin in `app.config.js`), so this is
done. Do not turn it off to simplify a build.

Two things to remember about it: the entitlement requires a provisioning
profile, so a local build without a team becomes a code-signing exercise; and
`AppleAuthentication.isAvailableAsync()` returns false without the entitlement,
so the button hides itself rather than dead-ending. Also, **Apple never returns
a profile photo** — its ID token has no `picture` claim — so Apple-only
accounts stay on the generic glyph forever. That is Apple's token, not a bug.

---

## What Sam has to do at Apple, in order

Each item is tagged:
**(a)** needed for TestFlight · **(b)** needed for in-app purchase to function
at all · **(c)** needed only for App Store release.

1. **(a)** Confirm the Apple Developer Program membership is active and not
   about to lapse. Everything below dies with it.
2. **(a)** App Store Connect → **Users and Access** → add yourself and anyone
   else who should get builds, then App Store Connect → the app → TestFlight →
   create an **Internal Testing** group and add them. Turn on automatic
   distribution of new builds.
3. **(a)** App Store Connect → **Users and Access** → **Integrations** → **App
   Store Connect API** → generate a key with the **App Manager** role, download
   the `.p8` (one shot), then run `eas credentials` on your Mac and store it
   with EAS. Without this the pipeline builds successfully and then fails to
   upload.
4. **(a)** Verify once by hand before trusting CI:
   `cd mobile && eas build --platform ios --profile production --auto-submit`.
   If EAS has never recorded a remote build number, seed it first with
   `eas build:version:set --platform ios`.
5. **(b)** App Store Connect → **Business** → **Agreements** tab → sign the
   **Paid Apps** agreement (Account Holder only). Then complete **Tax** and
   **Banking** in the same section. All three must read Active / submitted /
   Complete. **Do this early — banking validation is the slowest thing in this
   list, and until it clears, StoreKit returns zero products with no error.**
6. **(b)** developer.apple.com → App Store → **Small Business Program** →
   enrol. 15% instead of 30%; not automatic; takes effect 15 days after the end
   of the fiscal month in which it is approved. Every price and threshold in
   `subscriptions.md` and `src/server/payments/constants.ts` assumes it.
7. **(b)** App Store Connect → the app → **Monetization** → **Subscriptions** →
   create one subscription group, then `com.feraltravels.ios.monthly` ($2.00 /
   month) and `com.feraltravels.ios.annual` ($20.00 / year). Fill in
   localizations, prices and a review screenshot until each product leaves
   **Missing Metadata** and reads **Ready to Submit** — a product in Missing
   Metadata is invisible to StoreKit.
8. **(b)** App Store Connect → **Users and Access** → **Integrations** →
   **In-App Purchase** → generate an **In-App Purchase Key**, download the
   `.p8` (one shot), note the **Issuer ID**. This is a *different* key from
   step 3. It goes into RevenueCat.
9. **(b)** App Store Connect → **Users and Access** → **Sandbox** → create a
   Sandbox Apple Account on an address that has never been an Apple ID, and set
   its **Subscription Renewal Rate**. This is what lets a monthly subscription
   renew every five minutes instead of every month.
10. **(c)** Sign in with Apple — already implemented and enabled. Nothing to do
    unless someone disables it.
11. **(c)** App Store Connect → the app → **App Privacy** → complete the
    privacy nutrition label, and add a `PrivacyInfo.xcprivacy` privacy manifest
    to the app.
12. **(c)** Screenshots for every required device size, description, keywords,
    support URL (`https://www.feraltravels.com/support` — already public and
    covered by `e2e/legal-pages.spec.ts`), marketing URL, age rating.
13. **(c)** Create a **demo account** for App Review with a seeded trip, and
    make sure it never hits the paywall mid-review — the `comped` allowlist in
    `src/server/payments/comped.ts` is the mechanism.
14. **(c)** External TestFlight, if you want strangers: create an external
    group and submit the build for **Beta App Review**. Optional, and the first
    time Apple actually looks at the app.
15. **(c)** Submit for full App Review, with the two in-app purchases attached
    to the submission. Expect a rejection; it is normal, not a verdict.

**Shortest useful path:** items 1–4 get a build into your own hands this week.
Items 5–9 are the paperwork that makes money possible and should start
immediately because step 5 is the one with a queue in it. Items 10–15 are the
release, and none of them block testing.
