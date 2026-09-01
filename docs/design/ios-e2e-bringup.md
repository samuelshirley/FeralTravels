# iOS e2e bring-up — where this actually stands

**Status: 2026-09-01. All three flows pass, locally, on a real simulator.**
That replaces the line this document opened with for its first day of life —
"no Maestro flow has ever passed, anywhere" — which was true and was the point.
Nine separate things were wrong between a written flow and a green run, and not
one of them was a typo in a selector. They are listed below because every one of
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

## What is still unproven

- **No CI run.** The fixes to `.github/workflows/ci.yml` (Release, signing,
  keyboard preference) are the same ones proven locally, but the runner's Xcode
  is 26.2 against this machine's 26.6, and it boots headless with no
  Simulator.app.
- **Only one device.** iPhone 17 Pro / iOS 26.5. The `hideKeyboard` removal
  rests on the button clearing the keyboard, which is a claim about a screen
  size.
- **The send is not awaited.** `chat-keyboard.yaml` proves the button was
  hittable, not that Penny replied.

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

The bring-up above is the argument for the split, in nine parts. Items 1 and 2
are layer 1, items 3–8 are layer 2, item 9 is layer 3, and before the split all
of them arrived as one line reading `[Failed] chat-keyboard`.

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

## Next action

Push and watch the CI job. It is the only remaining unknown, and the three
things it does differently from this machine — Xcode 26.2, a headless boot, and
a preview URL instead of localhost — are each capable of failing on their own.
