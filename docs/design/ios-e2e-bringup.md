# iOS e2e bring-up — where this actually stands

**Status: 2026-09-01. No Maestro flow has ever passed, anywhere.** That is the
single most important sentence in this document. The flows in `mobile/maestro/`
were written from the source and merged without being executed once, so every
selector, every wait and every assumption about what the app does on launch is
still unverified. Treat a failure here as "this was never right" rather than
"something regressed".

## What IS proven

- **The driver starts.** CI run 119 (`11bbfcb`) got Maestro all the way to
  running a flow on an iPhone 17 Pro / iOS 26.2 simulator. Runs before it died
  at driver startup, on `iOS driver not ready in time` — which was an Xcode
  mismatch, not a timeout (see below).
- **The app builds and installs** on the simulator, from the same
  `expo prebuild` + `xcodebuild` commands the local script uses.
- **The fixture account mints.** `scripts/ios-e2e-fixture.mjs` seeds and reads
  back a real OTP against a target with `E2E_TEST_ENDPOINTS=1`.
- **The web Playwright suite is green** (92 passed on the same commit), so the
  API the app talks to is not the suspect.

## What is NOT proven

- `chat-keyboard.yaml` fails after 58 seconds. The JUnit says
  `<failure>Unknown error</failure>`, which names nothing.
- **We have never seen where it died.** The artifact came back 502 bytes
  because `upload-artifact` skips hidden files and Maestro writes its debug
  output under a dotted `.maestro/` directory. Fixed, but no run has yet
  produced a populated one.
- Whether the app reaches the trip screen at all, whether `E2E Fixture Trip`
  renders, whether the composer testIDs resolve on a real device — all
  unverified. The testIDs and the literal strings the flows use do exist in the
  source (`chat-composer`, `chat-composer-input`, `chat-composer-send`,
  `signin-email`, `signin-code-<i>`; `CHAT` is `item.label.toUpperCase()` in
  `BottomNav`), so the failure is more likely timing, navigation, or a screen
  that never appears than a typo.

## The loop to use

```bash
scripts/ios-e2e-local.sh doctor     # changes nothing; checks the machine
scripts/ios-e2e-local.sh all        # db → server → build → launch → sign-in → chat-keyboard
scripts/ios-e2e-local.sh run sign-in
scripts/ios-e2e-local.sh hierarchy  # the view tree of whatever is on screen
```

Everything lands in `mobile/maestro/.local-run/`. The file that answers "which
line of the yaml" is `commands-*.json` under the Maestro debug output — not the
JUnit, which says `Unknown error` regardless.

**Fix selectors from `hierarchy`, never from grep.** A `testID` in the source is
not proof of an `accessibilityIdentifier` on the rendered node, and this is
exactly the class of assumption that got these flows merged untested.

## Three layers, and why a red run must name one

`launch.yaml` (harness: driver + build + first render, no network) →
`sign-in.yaml` (wiring: the app can reach the API) →
`chat-keyboard.yaml` (behaviour: the thing under test).

Before this split, all three failed as one line reading `[Failed]
chat-keyboard`. An Xcode mismatch, an unreachable backend and a wrong selector
need completely different fixes, and one message for all three is how two CI
cycles produced no information.

## Traps, each of which has already cost a run

- **Xcode/driver pairing.** Maestro ships a *prebuilt* XCTest driver built with
  Xcode 26.2. An older `xcodebuild` cannot run its `.xctestrun`: it returns
  instantly, nothing listens on port 7001, and Maestro reports a timeout. The
  macos-15 default is 16.4, so `ci.yml` selects 26.2 explicitly — after the app
  build, which stays on the default 16.4 / iOS 18.5 SDK because that is the
  build that ships. Raising `MAESTRO_DRIVER_STARTUP_TIMEOUT` cannot help.
- **The OTP code is single-use.** `maestro test mobile/maestro` — the directory
  — runs `sign-in.yaml` standalone *and* through `chat-keyboard.yaml`; the first
  spends the code and the second fails on a row the server deleted. Always name
  the file.
- **`/api/test/*` on a deployed preview** is locked by a per-run HMAC of
  `AUTH_SECRET` and the CI run id. A laptop cannot reproduce it, and the failure
  is a 404 that looks like a missing route. Hence the local server.
- **The only `DATABASE_URL` in `.env` is production**, and these flows call
  `/api/test/seed`. Hence `docker-compose.e2e.yml`.
- **`command -v java` is true on every Mac**, because of a stub at
  `/usr/bin/java` that exists only to say there is no Java. The doctor learned
  this the hard way.

## Next action

Run `scripts/ios-e2e-local.sh all` on a Mac and read
`mobile/maestro/.local-run/`. Start at layer 1: if `launch.yaml` is red, nothing
below it is worth reading.
