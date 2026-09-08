# Reproduce the two native UI artifacts on a simulator

Read `docs/bugs/native-ui-fabric-artifacts.md` first. It contains a diagnosis
built entirely from reading React Native's source on disk. **Nothing in it was
ever observed running.** Your job is to make both failures happen on a real
simulator and report what you actually see. If the observation contradicts the
diagnosis, the diagnosis is wrong and I want to know that today, not after a
fix lands.

**Do not change any app code until both symptoms are reproduced.** And when you
do: fix the app, not the test. `mobile/maestro/sign-in.yaml` already documents a
bug in this exact component that was worked around in the flow instead of fixed
— that is why nothing caught this.

## The report (iOS, TestFlight, 2026-09-07)

On the six-box code screen in `mobile/app/sign-in.tsx`:

1. Tapping the first box raises the keyboard, and **the borders arrive after
   the boxes and their text** — the border visibly trails during the keyboard
   animation.
2. Tapping the keyboard's paste/autofill suggestion **put all six digits into
   box 0** and signed in anyway — so the submitted code was correct while the
   display was not.

## The loop

`scripts/ios-e2e-local.sh` is the fast path — build once, re-run a flow in ~60
seconds, against a local server and a local database. Read its header comment
before using it; it explains the three layers and why they are separate.

```
scripts/ios-e2e-local.sh doctor     # check the machine, change nothing
scripts/ios-e2e-local.sh up         # db + server
scripts/ios-e2e-local.sh build      # prebuild + xcodebuild + install
scripts/ios-e2e-local.sh run sign-in.yaml
scripts/ios-e2e-local.sh hierarchy  # dump the current screen's view tree
```

The simulator UDID comes from `node scripts/pick-ios-simulator.mjs` (first
field of its output) — the script already uses it that way at line 291. Do not
hardcode a UDID.

Note `XCODE_APP` defaults to `/Applications/Xcode_26.2.app` and the reason is in
the script: Maestro ships a prebuilt driver and an older `xcodebuild` cannot run
its `.xctestrun`. The only symptom is "iOS driver not ready in time", which
sounds like a slow machine and is not. If that Xcode is not installed, say so
and stop rather than downgrading the pin.

## Symptom 1 — the border lag

Hypothesis, from `mobile/node_modules/react-native`:

- `KeyboardAvoidingView` runs `LayoutAnimation.configureNext(...)` with the
  keyboard's duration and easing —
  `Libraries/Components/Keyboard/KeyboardAvoidingView.js:171`.
- Fabric only draws a border on the view's own layer when
  `useCoreAnimationBorderRendering` holds, which needs uniform border metrics
  and one of: zero border width, `clipsToBounds`, or a transparent border
  colour — `React/Fabric/Mounting/ComponentViews/View/RCTViewComponentView.mm:885-895`.
- A visible border with RN's default `overflow: visible` fails that and gets a
  separate `_borderLayer` CALayer (same file, ~931-950).
- `updateLayoutMetrics:` sets `_borderLayer.frame` at line 559 with no
  animation guard, inside the keyboard's animation block. The guard RN does
  have — `[layer removeAllAnimations]` at line 739, with a comment naming this
  exact hazard — only runs on the `invalidateLayer` path.

**Capture it.** Record the transition and look at frames, not at a live
simulator:

```
xcrun simctl io "$UDID" recordVideo --codec h264 border-lag.mov
```

Start the recording, tap `signin-code-0`, stop it. Extract frames at the
device's frame rate with `ffmpeg` and measure, per frame, the vertical offset
of the box's top border against the top of the digit glyph or the box fill.
Report the peak divergence in pixels and how many frames it persists. If the
two never diverge, say so — that kills the hypothesis.

**Then A/B it.** Add `overflow: 'hidden'` to the `codeBox` style (and `Card` in
`mobile/components/ui.tsx`). That sets `clipsToBounds`, which should satisfy
`useCoreAnimationBorderRendering` and move the border back onto the view's own
layer. Re-record and re-measure the same way.

- Divergence disappears → mechanism confirmed, and we know the cheap fix.
- Divergence survives → the diagnosis is wrong. Stop and report. Do not start
  guessing at a second cause.

Other call sites on the same path, worth a look once you know what to look for:
`app/trips/[tripId].tsx:308`, `components/SupportModal.tsx:66`.

## Symptom 2 — six digits in box 0

Three candidate defects, all in ~40 lines of `mobile/app/sign-in.tsx`:

- **a.** On the multi-digit branch, `boxes.current[CODE_LENGTH - 1]?.blur()`
  blurs box 5, which was never focused — box 0 is the first responder. This one
  is plainly true from reading it; confirm it holds on device.
- **b.** `React/Fabric/Mounting/ComponentViews/TextInput/RCTTextInputComponentView.mm:348`
  applies a JS-side text rewrite only when
  `_mostRecentEventCount == state.mostRecentEventCount`. If native emitted a
  newer text event in between, the update is dropped silently and the field
  keeps its own string. That would explain a correct sign-in with a wrong
  display exactly.
- **c.** The `selectTextOnFocus` + async `focus()` race already written up in
  `mobile/maestro/sign-in.yaml`. It was ruled harmless for paste and autofill.
  Test that claim.

**Reproduce the paste path, which is the one nothing currently exercises.**
`inputText` types character by character through XCTest and goes down the
per-character branch — that is why the existing flow types one digit per box,
and it is why the existing flow cannot see this bug. Find out what the pinned
Maestro (2.10.0) actually offers for a real paste — check `maestro --help` and
the installed CLI, do not assume `pasteText` exists or behaves as documented.
If Maestro cannot paste, put the string on the simulator pasteboard directly
(`xcrun simctl pbcopy "$UDID"`) and drive the keyboard's paste affordance, or
use Maestro Studio to find one that works.

Then assert what each box holds:

```
- assertVisible: { id: 'signin-code-0', text: '<first digit>' }
  ... through signin-code-5
```

Also dump the view hierarchy at the moment of failure
(`scripts/ios-e2e-local.sh hierarchy`) — it will show whether box 0's native
text really is the full six characters while JS state is correct, which is what
separates hypothesis (b) from the others.

Separately, exercise the real iOS one-time-code autofill if you can get it: the
simulator can deliver a `oneTimeCode` suggestion from a Messages payload. If
that path behaves differently from a pasteboard paste, that difference is the
finding.

## If you add a flow

`src/lib/maestroFlowParams.test.ts` fails if a flow references a `${VAR}` that a
runner does not supply. Its header explains why — the same mistake has been made
twice and both times it passed locally and failed only on CI. Update both
runners, or use no new variables.

## Ground rules

- Reproduce before diagnosing, diagnose before fixing.
- Any guard test you write gets mutation-checked: reintroduce the exact bug and
  watch the test go red. A test that has never failed is not a guard.
- Prefer a structural fix over a detector. For the digit boxes that means one
  `TextInput` owning the whole six-character string with six non-input `View`s
  rendering the digits: no cross-field focus moves, no per-box native text to
  desync, autofill lands in the one field that owns the value. That makes all
  three defects impossible rather than merely detectable. Propose it, do not
  land it, until the reproduction says what is actually broken.
- Report what you measured, including anything that failed to reproduce. "Could
  not reproduce" is a result.
