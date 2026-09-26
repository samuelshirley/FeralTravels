# iOS e2e bring-up — where this actually stands

**Status: 2026-09-01. All three flows pass, locally, on a real simulator.**
That replaces the line this document opened with for its first day of life —
"no Maestro flow has ever passed, anywhere" — which was true and was the point.
Eleven separate things were wrong between a written flow and a green run, and
not one of them was a typo in a selector. Two of the eleven were found *after*
all three flows were green, by reading the server log of the run that passed —
which is the argument for reading it. They are listed below because every one of
them was invisible to the CI job that was supposed to find them.

Still true, and worth keeping in mind: **nothing here has passed in CI yet.**
Local green is a much stronger claim than what came before it, but the runner
differs from a laptop in ways this bring-up already proved matter — see *What
is still unproven*.

## What is proven

- **All three flows pass**, run in order from a clean simulator boot:
  `launch` → `sign-in` → `chat-keyboard`.
- **The guard actually guards.** `chat-keyboard.yaml` was mutation-checked the
  way CLAUDE.md demands: the `KeyboardAvoidingView` was moved back inside
  `ChatPanel`, the app rebuilt, and the flow went red on
  `"keyboard visibility check" is visible` — with a screenshot showing the
  composer entirely behind the keyboard and the autocorrect bar spelling out
  the text being typed into a field nobody can see. Restored, green again.
  This is the first evidence that the flow tests the bug rather than resembling
  a test of it.
- **The real OTP sign-in works end to end on a device**: fixture seeded, code
  read back, typed into the six-box form, `POST /api/mobile/otp/verify` 200,
  session stored in the keychain, trips list rendering that user's own trip.

## What was wrong, in the order it had to be fixed

Each of these hid the next, which is why none of them showed up as nine
failures — they showed up as one, nine times.

1. **`location: deny` is not a valid Maestro permission.** iOS takes
   `always` / `inuse` / `never` / `location-always` for `location`;
   `allow`/`deny`/`unset` belong to `all`. It aborted the flow on its FIRST
   command, before the app was asked to render anything.
2. **The app was built `-configuration Debug`, which contains no JavaScript.**
   React Native's Debug path fetches its bundle from a Metro packager at launch
   and nothing ran one, so the app came up on the red box "No script URL
   provided". `launch.yaml` could not have passed under any selector. CI built
   Debug too. Now Release, in both places.
3. **`CODE_SIGNING_ALLOWED=NO` broke the keychain.** `expo-secure-store` needs
   entitlements an unsigned build does not have, so sign-in completed, the
   server returned a session, and the app died storing it. A simulator build
   signs ad hoc with no team or account, so the flag bought nothing.
4. **`clearState` does not clear the keychain.** Once the app could store a
   token, it survived reinstall and every run launched into `/trips`. Both
   flows now `clearKeychain` first. Note the shape: fixing (3) is what exposed
   this.
5. **`hideKeyboard` cannot work on that field.** It is `returnKeyType="send"`,
   so there is no standard dismiss action. It was also unnecessary — the button
   sits at y=463–505 and the keyboard starts at y=566.
6. **One `inputText` of a six-digit code loses a digit.** Maestro types rather
   than pastes, and each keystroke triggers an async `focus()` on the next box
   while every box has `selectTextOnFocus` — so a character arriving early
   replaces the previous one instead of appending. Five digits in six boxes,
   silently. Fixed in the flow (one digit per box); the app is right, because a
   real paste or autofill goes down the spread branch.
7. **There is no reachable "Verify code" tap.** The screen auto-submits on the
   sixth digit. Tapping it only ever "worked" because a digit was missing.
8. **The trip card is one accessibility element** reading
   `E2E Fixture Trip, 2026-09-15 → 2026-09-16`, and Maestro matches the whole
   label, so the bare name matched nothing.
9. **The simulator's software keyboard did not exist.** "Connect Hardware
   Keyboard" is the default: the field focuses, text types, nothing looks
   wrong, and `keyboardWillShow` never fires — so the nav never unmounts and
   the flow's "the keyboard is up" gate is false. It must be set BEFORE the
   device boots; setting it on a booted one does nothing.

Two more, found only because the run that "passed" was read rather than trusted:

10. **The server had no `ANTHROPIC_API_KEY`, and every send answered 503.**
    Next loads `.env.local` ahead of `.env`, and the Vercel CLI had written a
    `.env.local` listing every key with an EMPTY value — so a repo with a good
    key in `.env` ran a server with none. The same mechanism emptied
    `AUTH_SECRET`, which is where the `MissingSecret` noise in the log came
    from. The doctor had declared both present, because it grepped `.env` for a
    line rather than resolving what the server would see. Both are now passed
    explicitly into the server's process environment, which outranks every
    file, and the doctor checks the resolved value.
11. **`chat-keyboard.yaml`'s final assertion could not fail.**
    `visible: 'keyboard visibility check'` matched either the sent bubble or the
    same text still sitting unsent in the input — true in the working case and
    the broken one — so the flow went green with "AI service is temporarily
    unavailable" on screen. It now asserts the COMPOSER CLEARED: the placeholder
    is back and the send button is disabled, both of which flip on the tap alone
    (`setInput("")` runs before any network call) and neither of which waits on
    Penny. Mutation-checked by deleting the `setInput("")`: red, then restored.
    Deliberately still says nothing about the reply or the error bubble — this
    is a layout guard, and a dead AI service must not red it.

Two more, outside the flows, found on the way:

- **The migration chain cannot run from empty**, and never could:
  `0005_mute_meltdown` and `0006_nightly_replan` both create the `trip_status`
  type and column, the second unguarded, and `0002_magical_joystick` calls
  `setval(seq, 0)` on an empty `chat_history`. Nothing noticed because
  production was bootstrapped with `drizzle-kit push` and CI's preview is a
  clone of it — both start from a database that already has the schema. The
  local script bootstraps an empty database the same way the repo already
  documents.
- **The doctor could die silently.** `xcodebuild -version | head -1` under
  `pipefail` reports SIGPIPE as 141, which `set -e` turns into an exit with no
  message.

## The screenshots flow — its own bring-up, 2026-09-02

`screenshots.yaml` was merged with a header saying it had never been executed,
and predicting that its first run would be a bring-up rather than a regression.
It was, and it cost two runs. The shape was identical to the eleven above: the
failure was never where the message pointed.

1. **`takeScreenshot` is SANDBOXED in Maestro 2.10.** The flow wrote to an
   absolute `${SHOT_DIR}/01-trips`, on the reasoning — correct once — that a
   relative path resolves against Maestro's working directory rather than the
   repo. Maestro now refuses it outright:

       CommandFailed: Invalid path ".../.local-run/shots/01-trips.png" for
       takeScreenshot: it resolves outside this run's takeScreenshot output
       folder.

   The whole of `sign-in.yaml` had already passed at that point. The fix is bare
   names; the images land at
   `<--debug-output>/.maestro/tests/<timestamp>/<flow>/takeScreenshot/`, and
   `ios-e2e-local.sh` collects them from there. Confirmed with a two-line probe
   flow before touching the real one, which is the cheap way round a five-minute
   feedback loop.

2. **`'Penny is typing'` could never have matched.** `TypingBubble` puts that
   string in an `accessibilityLabel` on a plain `<View>` with no `accessible`
   prop, so iOS never promotes it to an accessibility element and it is simply
   not in the hierarchy. The flow waited 20 seconds for it, failed, and — this
   is the important part — **the server log said
   `POST /api/trip/replan 200 in 6058ms` and Penny's answer was on screen the
   entire time**. Dumping the tree at the moment of failure showed her reply,
   the cleared composer and the `Read` receipt, and no typing indicator
   anywhere.

   This is the same lesson as #2 and #11 in the list above: read the server log
   and the rendered tree, not the selector you wrote.

   Replaced with two gates that are in the tree: `Read` (the delivery receipt,
   which deliberately covers `typing` AND `responded`, so it means "she has it"
   and not "she is done"), then `waitForAnimationToEnd` for the stream itself.

3. **The keyboard has to go down BEFORE waiting out the stream.**
   `waitForAnimationToEnd` means "the screen stopped changing", and a blinking
   text caret never stops changing — so with the keyboard up it burns its entire
   budget on every run instead of returning when Penny finishes. Reordering it
   is not a tidy-up; it is the difference between a three-minute wait and a
   fifteen-second one.

4. **A bare `'REFILL EVERY'` matched nothing** on the Settings shot, because
   Maestro matches a text selector against the WHOLE accessibility label and
   that element reads `'REFILL EVERY ~300 km'` — the stat and its value merged
   by `VehicleProfileSection`. This is the SAME trap as the trip card in
   `sign-in.yaml`, which is documented in that file, in this document and in
   CLAUDE.md, and it still cost a run. If you are matching text, assume the
   label is the whole line and use a regex.

**Two generalisable rules came out of this.**

**`accessibilityLabel` on a bare `<View>` is invisible to Maestro.** No
`accessible` prop means no accessibility element means nothing in the hierarchy.
Check before writing any assertion against a label rather than a `testID` or
rendered text.

**Text selectors match the whole label, always.** Three separate flows have now
been bitten by it. Prefer a `testID`; if it has to be text, write the regex.

## Passing is not the same as usable

Worth stating on its own, because it is the thing the automation cannot do and
the reason the images are committed rather than trusted. The run that finally
went green produced five correctly-sized PNGs of which **three were not
shippable**: the itinerary read *"No fuel stop needed on this day"* (the
canonical day 1 is 489 km and the fixture range was 500, so Finn correctly
placed nothing — a picture of the app idle, in the slot meant to show it
working), the map was a blank grid because the simulator's Apple Maps tiles
never loaded, and Settings showed the fixture's `e2e.feraltravels.com` address
in the middle of the frame.

Two of those are fixed (`seedCanonicalFixture` took an optional `rangeKm`; the
Settings shot centres the range stat instead of the section heading). The map is
not fixable from a flow. `mobile/screenshots/README.md` carries the per-image
verdict.

## What is still unproven

- **No CI run.** The fixes to `.github/workflows/ci.yml` (Release, signing,
  keyboard preference) are the same ones proven locally, but the runner's Xcode
  is 26.2 against this machine's 26.6, and it boots headless with no
  Simulator.app.
- **Only one device.** iPhone 17 Pro / iOS 26.5. The `hideKeyboard` removal
  rests on the button clearing the keyboard, which is a claim about a screen
  size.
- **The send is not awaited.** `chat-keyboard.yaml` proves the button was
  hittable and that the composer cleared, not that Penny replied. That is on
  purpose — see item 11 — but it does mean this suite would not notice Penny
  answering with nonsense, only her never being asked.

## The loop to use

```bash
scripts/ios-e2e-local.sh doctor     # changes nothing; checks the machine
scripts/ios-e2e-local.sh all        # db → server → build → launch → sign-in → chat-keyboard
scripts/ios-e2e-local.sh run sign-in
scripts/ios-e2e-local.sh hierarchy  # the view tree of whatever is on screen
```

Everything lands in `mobile/maestro/.local-run/`. The file that answers "which
line of the yaml" is `commands-*.json` under the Maestro debug output — not the
JUnit, which says `Unknown error` regardless. The screenshot beside it is worth
more than both: items 2, 9 and the mutation check were all read straight off one.

**Fix selectors from `hierarchy`, never from grep.** A `testID` in the source is
not proof of an `accessibilityIdentifier` on the rendered node — and, per item 8
above, it is not proof of what the node's LABEL says either.

## Three layers, and why a red run must name one

`launch.yaml` (harness: driver + build + first render, no network) →
`sign-in.yaml` (wiring: the app can reach the API) →
`chat-keyboard.yaml` (behaviour: the thing under test).

The bring-up above is the argument for the split. Items 1 and 2 are layer 1,
items 3–8 are layer 2, items 9 and 11 are layer 3, and before the split all of
them arrived as one line reading `[Failed] chat-keyboard`. Item 10 is the
reminder that the split does not help with a flow that asserts the wrong thing:
green named no layer either.

## Traps, each of which has already cost a run

- **Xcode/driver pairing.** Maestro ships a *prebuilt* XCTest driver built with
  Xcode 26.2. An older `xcodebuild` cannot run its `.xctestrun`: it returns
  instantly, nothing listens on port 7001, and Maestro reports a timeout.
  Raising `MAESTRO_DRIVER_STARTUP_TIMEOUT` cannot help.
- **The OTP code is single-use.** `maestro test mobile/maestro` — the directory
  — runs `sign-in.yaml` standalone *and* through `chat-keyboard.yaml`; the first
  spends the code and the second fails on a row the server deleted. Always name
  the file.
- **The flow re-sends an OTP.** Tapping "Email me a code" sends again on an
  address the fixture already sent to. It survives because the server rate-limits
  the resend and keeps the original code; a change to that policy breaks
  `sign-in.yaml` in a way that will read as a wrong code.
- **`/api/test/*` on a deployed preview** is locked by a per-run HMAC of
  `AUTH_SECRET` and the CI run id. A laptop cannot reproduce it, and the failure
  is a 404 that looks like a missing route. Hence the local server.
- **The only `DATABASE_URL` in `.env` is production**, and these flows call
  `/api/test/seed`. Hence a throwaway local database.
- **`command -v java` is true on every Mac**, because of a stub at
  `/usr/bin/java` that exists only to say there is no Java.

## The driver-timeout flake, and the bounded retry (2026-09-07)

`iOS driver not ready in time, consider increasing timeout` has two causes
with one message. The first is the Xcode pairing above — `xcodebuild` returns
instantly and nothing ever listens — and it is fixed by `xcode-select`, never
by the timeout. The second showed up on run 34101156123 with the pairing
correct: `xcodebuild test-without-building` started, printed two
`IDERunDestination` warnings, and then STALLED launching the runner on a
freshly booted simulator. The runner log (`xctest_runner_*.log` in the
artifact) is six lines and never reaches `Running tests…`; on a green run it
reaches it in about thirty seconds. Same image (`macos-15-arm64`
20260829.0321.1), same Maestro 2.10.0, same Xcode 26.2 as the green run three
days earlier. A CoreSimulator flake, low frequency, and a hang — so a longer
timeout cannot fix it either.

Two things in `ci.yml` answer it. The boot step launches and terminates the
app once before Maestro is involved, so SpringBoard's first-run work happens
on our clock. And `launch.yaml` is retried ONCE, on that one signature only,
after killing the stuck `xcodebuild` and rebooting the same UDID. It is scoped
to `launch.yaml` because that flow is the harness gate: it touches no fixture
and no network, so a retry there cannot spend an OTP or a location prompt.
Any other failure — including a red `launch.yaml` for a reason that is not
the driver — is not retried. The PR comment says "Harness retried once" when
it happened, so the flake rate stays readable from the PR thread.

**How to tell the two apart in a log:** look at the runner log's length. Six
lines ending in destination warnings is the stall; a runner log that never
exists at all (`xcodebuild` exiting at once) is the Xcode mismatch.

## Next action

Push and watch the CI job. It is the only remaining unknown, and the three
things it does differently from this machine — Xcode 26.2, a headless boot, and
a preview URL instead of localhost — are each capable of failing on their own.


---

## iOS E2E — the CLAUDE.md notes

> Moved out of `CLAUDE.md` on 2026-09-20, verbatim, when that file was cut from
> 225 KB back to a map. Nothing here was rewritten or deleted — only relocated.
> `CLAUDE.md` links here from the one-line summary that replaced it.

### iOS E2E (`mobile/maestro/`)

`launch.yaml`, `sign-in.yaml`, `chat-keyboard.yaml`, `chat-tab-in-flight.yaml`, `maps-link-stop.yaml`, `screenshots.yaml` — Maestro flows driving a **real iOS simulator** against the PR's own Vercel preview (`EXPO_PUBLIC_API_URL` is inlined at bundle time, so the build points at that preview). Run by the `iOS e2e (simulator)` job in `ci.yml`.

**Start at `docs/design/ios-e2e-bringup.md`** — it records what is proven, what is not, and the traps. **All three flows pass locally as of 2026-09-01** (they had never passed anywhere before that), and `chat-keyboard.yaml` has been mutation-checked: the `KeyboardAvoidingView` was put back inside `ChatPanel`, the flow went red on the typed text being invisible, and the screenshot shows the composer behind the keyboard. Nine separate things were wrong, each hiding the next, and the bring-up doc lists them in the order they had to be fixed — none was a typo in a selector. **Not yet proven in CI.**

**`screenshots.yaml` is not a test and does not run in CI.** It walks the seeded trip on a PINNED device size and writes the App Store set into `mobile/screenshots/<size>/` — `scripts/ios-e2e-local.sh screenshots [size]`, default 6.9. It reuses `sign-in.yaml`, so it inherits the keychain clear and the per-box code entry rather than re-deriving them, and it seeds the same canonical two legs under names a customer could read. Every PNG is measured with `sips` before it is kept, because a set that is silently the wrong size is otherwise something you find out at upload. **Location stays denied**, which is a decision and not an oversight: granting it makes `DeviceLocationContext` report a position and `report_position` RE-ANCHORS the trip to wherever the simulator thinks it is, so a Paris trip quietly becomes a Californian one. **It runs and passes as of 2026-09-02** (iPhone 17 Pro Max, 1320x2868), and its first run was a bring-up exactly as predicted: `takeScreenshot` is SANDBOXED in Maestro 2.10 so the path must be a BARE name (an absolute one is refused — the images land under `<--debug-output>/.maestro/tests/<ts>/<flow>/takeScreenshot/` and the runner collects them from there), and `'Penny is typing'` could never have matched because that label sits on a `<View>` with no `accessible` prop and is therefore absent from the hierarchy — the server had answered `200 in 6058ms` and her reply was on screen the whole time. **Passing is not the same as usable:** looking at the output found three of five images unshippable, including the fixture's `e2e.feraltravels.com` address plainly visible in the Settings shot and a map that was a blank grid (that one is INTERMITTENT — Apple Maps tiles had not loaded on a freshly booted simulator, and a later run on the warmed one rendered properly; re-run if it comes out blank). `mobile/screenshots/README.md` has the per-image verdict and what still needs a decision. `seedCanonicalFixture` gained an optional `rangeKm` for this — the canonical day 1 is 489km against the Hilux's real 500km, so Finn correctly placed NO stop and the "itinerary with fuel stops" shot read "No fuel stop needed on this day".

**`maps-link-stop.yaml` depends on LIVE Google, on purpose (2026-09-26).** It is the regression flow for the share link `https://maps.app.goo.gl/ys3PKbHMPZbQq8o29?g_st=ic` that Penny said she could not resolve. `seed-maps-link-stop.js` seeds the canonical "August Portugal Trip" (`/api/test/trip` `kind: 'canonical'`), then posts the real link to `/api/test/maps-link-stop`, which runs Penny's own path minus the model — `resolveMapsLinksInMessage` → `VALIDATORS.add_stop` → `applyAddStop` — so there is no Anthropic call. The flow opens only the Porto → Lisbon day (by `testID` `leg-card-<id>`) and asserts the Praça do Comércio stop is listed. The preview fetches the link from Google on every run: one free redirect walk and, on the page Google serves today, ZERO paid Places calls. That dependency is the point — the resolver keeps having to track what Google's share pages look like, and a mocked page would only prove what Google did once. When Google changes again, the script throws with the resolver's `stage` (`no_coords`, `geocode_miss`, `http_<n>`, …) in the error, and `/admin/errors` has the matching `penny:maps-link` row. The seed stamps every sourced leg's fuel cache fresh; never open an unsourced day (Lisbon → Madrid area) in this flow, or Finn runs a paid search. **Its first simulator run is CI on the PR that added it** — the seed and endpoint were exercised against a throwaway local database, the simulator half was not run locally.

**Three layers, deliberately separate (2026-09-01).** `launch.yaml` needs no network and no fixture account: it proves the XCTest driver came up, the build installed and the app renders. `sign-in.yaml` proves the app can reach the API. `chat-keyboard.yaml` is the thing under test. They are separate because all three used to fail as one line reading `[Failed] chat-keyboard`, and an Xcode mismatch, an unreachable backend and a wrong selector need completely different fixes. CI runs `launch` first; `scripts/ios-e2e-local.sh all` does the same locally.

**The app is built `-configuration Release`, and signed.** Both are corrections, not preferences, and both were silently fatal. A **Debug** build contains no JavaScript — React Native fetches its bundle from a Metro packager at launch and nothing runs one — so the installed app came up on the red box "No script URL provided" and `launch.yaml` could not have passed under any selector. And `CODE_SIGNING_ALLOWED=NO` strips the entitlements `expo-secure-store` needs, so sign-in completed, the server returned a session, and the app died storing it in the keychain (`setToken` does not catch that, deliberately). A simulator build signs ad hoc with no team or account.

**`clearState` does not clear the keychain, so both flows `clearKeychain` first.** A keychain item outlives the app that wrote it, uninstall included — so once the build was signed well enough to store a session token, every run launched straight into `/trips`. This only surfaced once the signing was fixed, which is the recurring shape here.

**The simulator's software keyboard must be turned on explicitly** — `defaults write com.apple.iphonesimulator ConnectHardwareKeyboard -bool false`, **before the device boots** (setting it on a booted one does nothing). The default is a hardware keyboard: the field focuses, text types, nothing looks wrong, and `keyboardWillShow` never fires — so the nav never unmounts and `chat-keyboard.yaml`'s "the keyboard is up" gate is false. It is the one setting the whole regression test rests on.

**Selectors come from the rendered tree, and the label is not the testID.** The trip card is ONE accessibility element reading `E2E Fixture Trip, 2026-09-15 → 2026-09-16`, and Maestro matches the whole label, so the flows use `.*E2E Fixture Trip.*`. The six-digit code is entered **one digit per box**: Maestro types rather than pastes, and each keystroke triggers an async `focus()` on the next box while every box carries `selectTextOnFocus`, so at machine speed a character replaces the previous one instead of appending — five digits in six boxes, with no error anywhere. The app is right (a real paste or iOS autofill takes the spread branch); the flow was wrong. There is also no reachable `Verify code` tap — the screen auto-submits on the sixth digit.

**The Xcode pairing is load-bearing.** Maestro does not compile its iOS driver on the runner — it ships a prebuilt `maestro-driver-iosUITests-Runner.app` and `.xctestrun` built with **Xcode 26.2** (`rebuild-ios-drivers.yaml` in mobile-dev-inc/maestro). The default Xcode on `macos-15` is 16.4 and cannot run it: `xcodebuild` returns instantly, nothing listens on port 7001, and Maestro reports `iOS driver not ready in time, consider increasing timeout` — a message that names a timeout and is not about one. Raising `MAESTRO_DRIVER_STARTUP_TIMEOUT` cannot help. So `ci.yml` selects Xcode 26.2 **after** the app build (the app keeps compiling against the default 16.4 / iOS 18.5 SDK, which is the build that ships, and an 18.5 app runs fine on a 26.2 simulator), pins `MAESTRO_VERSION`, and boots the newest runtime on the image. **When bumping Maestro, check which Xcode that release's `rebuild-ios-drivers.yaml` used and move the `xcode-select` with it.**

**`launch.yaml` is retried once on `iOS driver not ready in time` and on nothing else (2026-09-07).** With the Xcode pairing correct, `xcodebuild test-without-building` can still stall launching Maestro's runner on a freshly booted simulator (run 34101156123: the runner log stops after two `IDERunDestination` warnings). The boot step now launches and terminates the app once to warm the simulator, and the flows step retries only `launch.yaml`, only on that signature, after killing the stuck `xcodebuild` and rebooting the same UDID — a flow assertion is never retried, and the PR comment says "Harness retried once" when it happened. `docs/design/ios-e2e-bringup.md` has the two-causes-one-message table.

**`include-hidden-files: true` on the artifact upload is not tidiness.** Maestro writes its debug output under `<--debug-output>/.maestro/tests/<timestamp>/` — a dotted directory — and `upload-artifact` has skipped hidden files by default since v4.4. Run 119's `maestro-ios` artifact was **502 bytes holding one file** while the PR comment pointed at it as "a screenshot of the screen it died on".

**Why not React Native Testing Library.** RNTL renders a component tree in JS with no layout engine and no keyboard. It would find the composer, assert it exists, and go green while the app was unusable — the same green-but-empty shape `scripts/assert-e2e-ran.mjs` exists to catch. `Mobile typecheck` has the same blind spot: the bug in `d316cd6` compiled perfectly and hid the chat composer behind the keyboard on every iPhone.

**`chat-keyboard.yaml` is a guard test and its assertions are shaped deliberately.** `assertVisible` is a weak gate for occlusion — an element under the keyboard's own window can still report as present — so the real gate is BEHAVIOURAL: `tapOn` the send button while the keyboard is up, which only lands if the element is genuinely hittable. With the bug present those coordinates belong to a keyboard key. Do not simplify it to an `assertVisible`. It also asserts the bottom nav is ABSENT while the keyboard is up, which is how it knows the keyboard opened at all rather than passing because the tap did nothing.

**The send is proved by the COMPOSER CLEARING, never by the text being on screen.** `sendMessage` does `setInput("")` before any network call and `sendEnabled` is `hasComposerText`, so the empty placeholder (`Ask Penny…`) and a disabled `chat-composer-send` both flip on the tap alone — observable without waiting on Penny. The assertion this replaced, `visible: 'keyboard visibility check'`, matched either the sent bubble OR the same text still sitting unsent in the input, so it was true in both the working and the broken case: it passed for a week against a server answering **503 to every replan**, with "AI service is temporarily unavailable" on screen. Mutation-checked by deleting the `setInput("")`. Deliberately no assertion on Penny's reply or on the error bubble — this is a layout guard, and a dead AI service must not red it.

**The local server needs `ANTHROPIC_API_KEY` passed in its process env, not left to `.env`.** Next loads **`.env.local` ahead of `.env`**, and the Vercel CLI writes a `.env.local` listing every key with an EMPTY value — so a repo with a good key in `.env` runs a server with none. That is what produced the 503s above, and the `MissingSecret` errors from an `AUTH_SECRET` the doctor had just declared present. `scripts/ios-e2e-local.sh` resolves both through `env_value` (process env → `.env.local` → `.env`, skipping empty assignments) and passes them explicitly the way it already did `DATABASE_URL`; the doctor checks that resolved value rather than grepping a file for a line.

**Cost — and the job is NOT gated, and does NOT cache the build.** Both of those were true once and this paragraph described them long after they stopped being. There is **no diff gate** (removed 2026-08-28): the repository is public so macOS Actions minutes are free, and the app is now the only client — a change under `src/app/api/` touches nothing in `mobile/`, would have skipped the simulator, and is exactly the change most likely to break the trips screen. There is **no `.app` cache** either: it was keyed on a native fingerprint while `EXPO_PUBLIC_API_URL` is inlined at BUNDLE time, so a cache hit would have launched the simulator against a previous PR's torn-down preview URL — sign-in failing against a dead host, looking like a broken app. Every run compiles. What the job does cache is `~/.maestro`, keyed on the pinned `MAESTRO_VERSION` (a job-level env, so the key and the installer cannot disagree). The `xcodebuild` call carries **no** extra build settings, and that is measured rather than overlooked: `ONLY_ACTIVE_ARCH=YES` / `COMPILER_INDEX_STORE_ENABLE=NO` / `DEBUG_INFORMATION_FORMAT=dwarf` moved the build 14m06s → 14m46s, i.e. nothing outside runner noise, and the arch flag was a **no-op** — both logs carry the same four `-arch x86_64` lines and all four are `clang -v -E -dM … /dev/null` toolchain probes, not compilation, so the build was already arm64-only. Don't re-add them without a measurement.

**`legal-pages`** asserts `/privacy`, `/terms`, `/support` and `/legal/*` are 200 for an anonymous caller — the one property whose failure is an App Review or Google brand-verification rejection, and which nothing else in the suite can notice because every other spec signs in first. It checks both the raw HTTP response (what a crawler gets) and the rendered page (what a human gets).

**`oauth-exchange`** fires forged ID tokens at `POST /api/mobile/oauth/exchange` against the deployed preview: malformed bodies → 400, and structurally perfect JWTs signed with a key the provider never published → 401 `InvalidToken`, including the wrong-audience (confused-deputy), wrong-issuer, expired and **no-`exp`** cases. It also asserts a refusal never carries a session token and never leaks jose's own message. The happy path is unreachable from CI (we cannot mint a token Google or Apple would vouch for) and lives in `oauthIdentity.test.ts` plus a real device. **One test doubles as a config check:** "the Google provider is configured on this deployment" fails with 503 when `AUTH_GOOGLE_IOS_CLIENT_ID` is unset in the target Vercel environment — the fix is to set the variable, not to relax the test, because an unset one means every Google sign-in from the iOS app 503s with nothing on the web side to notice it by.
