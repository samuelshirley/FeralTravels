# Mobile release — how a merge reaches a tester

The mobile release is its own workflow, `.github/workflows/mobile.yml`,
triggered by the same push to `main` as `deploy-production.yml`. The two start
together, but since 2026-09-22 (issue #39) nothing reaches a device — neither the
OTA nor a TestFlight build — until production serves the commit: its own deploy
succeeded, or a later main deploy that contains it did. See
`docs/design/deploy-pipeline.md`. (An earlier version of this file described one
`pipeline.yml` with the mobile jobs on `needs: deploy`; that consolidation was
drafted and never landed.) Read `mobile.yml`'s header for the mechanics; this
file is the setup and the traps.

## What a merge to `main` does

The workflow diffs the merge against the previous `main` and picks one of two
paths:

| Changed under `mobile/` | Path | Time to tester |
|---|---|---|
| JS/TS only | `eas update` — OTA to the `production` channel | seconds, next app launch |
| `app.config.js`, `package.json`, `package-lock.json`, `eas.json`, `assets/**` | `eas build` — new binary | ~30 min queue + ASC processing |

`mobile/ios` and `mobile/android` are gitignored (CNG; EAS regenerates them),
so they never appear in a diff — that's why the native list is the *inputs* to
prebuild rather than its output.

**There is NO fingerprint check — this file used to say there was.** An
earlier version described `decide` computing the native fingerprint
(`expo-updates fingerprint:generate`) and asking EAS whether any build carried it
before publishing an OTA. That step lived only in the workflow drafts
(`pipeline.yml.new` / `mobile-workflow.new.yml`, committed in `960a73c`), which
never ran and were deleted; `mobile.yml` has never computed a fingerprint
(`git log -S fingerprint -- .github/workflows/mobile.yml` is empty). Corrected
2026-09-22.

**What does protect an installed binary**, and the gap left open:

- The classifier (`scripts/decide-mobile-release.mjs`) sends every merge that
  moves a native input to a native build and **skips the OTA** for it, so a
  native change never ships as a bundle.
- `runtimeVersion: { policy: 'appVersion' }` (`app.config.js`) keeps an OTA off
  binaries of a different `version` — but only when `version` is bumped. PR #7
  broke that promise without touching `version`: a CFBundleURLScheme and the
  Apple Sign-in entitlement, with two pre-OAuth builds still valid 1.0.0
  targets.
- **The gap:** a JS-only merge that lands *after* such a native change, while
  the old binaries are still installed (or the native build never finished),
  publishes to them. Nothing checks for it today. The two fixes are the one the
  drafts described (fingerprint + an EAS query before `eas update`) or
  `runtimeVersion: { policy: 'fingerprint' }`, which moves the guarantee into
  update targeting itself — so a mismatched binary could never be a target, even
  for a hand-run `eas update`. The latter changes what reaches installed builds,
  so do it as its own change, after a release, not before one.

## Setup

### 1. `EXPO_TOKEN` (required — nothing works without it)

expo.dev → account settings → **Access tokens** → create one.

**It must belong to the account that owns the project** — `owner` in
`app.config.js`, currently `samuelashirley`. This is the whole ballgame and it
cost a day to learn. A token from any other Expo account fails every call with:

```
Entity not authorized: AppEntity[8228a0d9-...]
(viewer = RobotViewerContext, action = READ)
```

Two runs died on exactly that. Prefer a **personal access token** under
`samuelashirley` while you are the only developer. A robot user is the tidier
answer for a team — it can be revoked without logging you out — but a freshly
created robot has *no permissions at all* until you grant it a role, and a
robot created under a different account or org can never be granted access to
this project. If you use one, create it under `samuelashirley` and give it
Admin.

**Where things actually live**, because there are three Expo accounts and only
one of them matters:

| Account | What's in it |
|---|---|
| `samuelashirley` (personal) | **everything real** — the `feral-travels` project, all builds, the Apple cert, the ASC API key, the CI token |
| `Feral Travels` (org) | an empty duplicate project, zero builds. Harmless; nothing points at it |
| `sivale` (org) | unrelated |

`app.config.js` names `owner: 'samuelashirley'` and projectId
`8228a0d9-1f26-4a3a-bcf0-aa86d90c3886`. If either ever stops matching the
personal account, everything below breaks at once.

GitHub → repo Settings → Secrets and variables → Actions → **Secrets** → New
repository secret, named `EXPO_TOKEN`.

### 2. App Store Connect credentials (needed only for auto-submit)

`submit.production.ios` in `eas.json` pins `ascAppId` and `appleTeamId` — but
those are identifiers, not credentials. Interactive `eas submit` on your Mac
prompts for the rest; a CI run has nobody to prompt, so `--auto-submit` fails
*after* the build succeeds.

Use an App Store Connect **API key**, not an Apple ID + app-specific password:
it doesn't carry 2FA and doesn't expire when your password changes.

1. App Store Connect → Users and Access → Integrations → **App Store Connect
   API** → generate a key with the **App Manager** role. You can download the
   `.p8` exactly once.
2. Easiest path: run `eas credentials` on your Mac, pick iOS → production →
   App Store Connect API Key, and let EAS store it. Then `eas.json` needs
   nothing further and CI picks it up from the EAS servers.
3. Turn on auto-submit: GitHub → Settings → Secrets and variables → Actions →
   **Variables** tab (not Secrets) → `EAS_AUTO_SUBMIT` = `true`.

Verify once by hand before trusting it in CI:

```bash
cd mobile
eas build --platform ios --profile production --auto-submit
```

### 3. First build only

`eas.json` sets `appVersionSource: "remote"`, so EAS owns `buildNumber` and
`autoIncrement: true` bumps it per build — nothing is committed back to the
repo. If EAS has no remote version recorded yet, seed it once:

```bash
cd mobile && eas build:version:set --platform ios
```

## Traps

**Bumping `version` strands every OTA.** `runtimeVersion` policy is
`appVersion`, so an update published at `1.0.1` only reaches `1.0.1` binaries.
Change `version` in `app.config.js` and every tester on the old build stops
receiving updates until they install a new binary. The workflow treats
`app.config.js` as a native input specifically so this always cuts a build —
don't "optimise" that path filter away.

**`eas.json` env is build-only.** The `build.production.env` block does not
apply to `eas update`; `EXPO_PUBLIC_*` values are inlined into the bundle at
bundle time. The workflow reads the block out of `eas.json` and exports it
before publishing. Without that, `lib/config.ts` falls back — `API_BASE_URL`
survives (it defaults to prod) but `GOOGLE_IOS_CLIENT_ID` becomes `null` and
`APPLE_SIGNIN_ENABLED` becomes `false`, i.e. an OTA that quietly removes both
social sign-in buttons for everyone.

**A green Mobile job means "queued".** The build step is `--no-wait`. Track the
real build on expo.dev.

**The mobile gate is typecheck-only.** The pipeline has a `Mobile typecheck` job
(`tsc --noEmit` in `mobile/`) and the unit project carries the mirror-drift
guard, but `mobile/` still has no test suite of its own — no component specs,
no Detox, nothing that exercises a screen. A change that compiles and drifts
nothing can still be wrong, and an OTA puts it on devices in seconds. Treat
TestFlight as the test suite for behaviour, and keep the release notes honest
about what changed.

## Forcing a path by hand

Actions → **Mobile** → Run workflow → `mode`:

- `update` — publish an OTA even though the diff looks native (rarely correct)
- `build` — cut a binary even for a JS-only change (e.g. after changing an EAS
  credential, or to get a fresh TestFlight build for a reviewer)
