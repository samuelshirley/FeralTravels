# Mobile release — how a merge reaches a tester

`ci.yml` and `promote.yml` are the **web** pipeline. They deploy Next.js to
Vercel and know nothing about `mobile/`. The mobile half is
`.github/workflows/mobile.yml`; read its header for the mechanics, this file is
the setup and the traps.

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

## Setup

### 1. `EXPO_TOKEN` (required — nothing works without it)

expo.dev → account settings → **Access tokens** → create one. Prefer a robot
account under the `samuelashirley` org over a personal token, so revoking it
doesn't log you out everywhere.

GitHub → repo Settings → Secrets and variables → Actions → **Secrets** → New
repository secret, named `EXPO_TOKEN`.

### 2. App Store Connect credentials (needed only for auto-submit)

`submit.production` in `eas.json` is currently `{}`. That's fine for
interactive `eas submit` on your Mac, where it prompts — but a CI run has
nobody to prompt, so `--auto-submit` fails *after* the build succeeds.

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

**There is no test gate on the mobile path.** `ci.yml` runs vitest and
Playwright against the web app; nothing type-checks or tests `mobile/` in CI.
Until that exists, `cd mobile && npx tsc --noEmit` before merging is the only
thing standing between a typo and every tester's phone. Worth adding as a
required check.

## Forcing a path by hand

Actions → **Mobile** → Run workflow → `mode`:

- `update` — publish an OTA even though the diff looks native (rarely correct)
- `build` — cut a binary even for a JS-only change (e.g. after changing an EAS
  credential, or to get a fresh TestFlight build for a reviewer)
