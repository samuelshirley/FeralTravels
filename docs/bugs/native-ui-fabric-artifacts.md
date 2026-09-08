# Wonky native UI: it is the New Architecture, not a component library

Investigation only — nothing fixed, nothing reproduced on a device. Read the
"What is NOT established" section before acting on any of this.

Reported (iOS, TestFlight, 2026-09-07): on the six-box code screen, tapping the
first box raises the keyboard and **the borders arrive after the boxes and the
text**; and tapping the keyboard's paste/autofill suggestion **put all six
digits in box 0** and signed in anyway.

## It is not a component library and there is no DOM

`mobile/package.json` ships no UI kit — phosphor-react-native (icons),
react-native-svg, maps, purchases, screens, safe-area-context, sse. Nothing
that owns layout or draws a border.

What it does ship is `newArchEnabled: true` (`mobile/app.config.js`), Expo SDK
54 / RN 0.81.5. Both symptoms trace to Fabric.

## 1. The border lag

Every link verified in `mobile/node_modules/react-native` on disk:

1. `KeyboardAvoidingView` calls `LayoutAnimation.configureNext(...)` with the
   keyboard's own duration and easing on iOS —
   `Libraries/Components/Keyboard/KeyboardAvoidingView.js:171`. The keyboard
   opening is an animation block.
2. Fabric only draws a border with `layer.borderWidth` when
   `useCoreAnimationBorderRendering` holds, which needs uniform border metrics
   AND one of: zero border width, `clipsToBounds`, or a fully transparent
   border colour —
   `React/Fabric/Mounting/ComponentViews/View/RCTViewComponentView.mm:885-895`.
3. A view with a visible border and RN's default `overflow: visible` fails that
   test and falls to the slow path: a **separate `_borderLayer` CALayer** whose
   contents is a stretched border image (same file, ~931-950). `codeBox` and
   `Card` are both on this path.
4. `updateLayoutMetrics:` sets `_borderLayer.frame = self.layer.bounds`
   directly at line 559 — with no animation guard. RN knows the hazard and says
   so at lines 737-739: *"If mutations are applied inside of Animation block, it
   may cause layer to be animated. To stop that, imperatively remove all
   animations from layer."* That `removeAllAnimations` only runs on the
   `RCTAddContourEffectToLayer` path called from `invalidateLayer` in
   `finalizeUpdates` — a different point in the mount transaction.

So the border layer picks up CA's default 0.25s ease-in-ease-out while the view
and its text move on the keyboard curve. The border trails.

**The experiment that would settle it in 30 seconds on a dev build:** add
`overflow: 'hidden'` to `codeBox` (and `Card`). That sets `clipsToBounds`,
which satisfies `useCoreAnimationBorderRendering`, which puts the border back on
the view's own layer where it cannot desync. If the lag disappears, the
diagnosis is confirmed. If it does not, this whole section is wrong.

Blast radius is every bordered view inside a `KeyboardAvoidingView`:
`app/sign-in.tsx:386`, `app/trips/[tripId].tsx:308`,
`components/SupportModal.tsx:66`.

## 2. Six digits in box 0

Three separate defects, in about forty lines of `app/sign-in.tsx`.

**a. The wrong element is blurred.** On the multi-digit paste branch:

```ts
if (lastFilled >= CODE_LENGTH - 1) boxes.current[CODE_LENGTH - 1]?.blur();
```

Box 5 was never focused — box 0 is the first responder. `blur()` on an
unfocused input is a no-op, so nothing is dismissed and box 0 keeps focus and
keeps its native text.

**b. Fabric silently discards the correction.**
`React/Fabric/Mounting/ComponentViews/TextInput/RCTTextInputComponentView.mm:348`:

```objc
if (_mostRecentEventCount == _state->getData().mostRecentEventCount) {
  _comingFromJS = YES;
  [self _setAttributedString:...];
  _comingFromJS = NO;
}
```

A JS-side rewrite of a TextInput's text is applied **only** if native has not
emitted a newer text event in the meantime. If it has, the update is dropped
with no error and the field keeps its own string. That is the reported
behaviour exactly: JS state held `["1","2","3","4","5","6"]`, so `joined` was
correct, so the auto-submit signed in — while box 0 still displayed all six.
This exposes anything that rewrites a TextInput in response to `onChangeText`:
OTP spreading, input masks, formatters.

**c. A race we already found, wrote down, and routed around.**
`mobile/maestro/sign-in.yaml` documents it: each keystroke sets a box and calls
`focus()` on the next one asynchronously while every box carries
`selectTextOnFocus`, so a character arriving before that focus lands replaces
the previous box instead of appending. Observed in CI as `8 0 8 8 8 _`.

The flow was rewritten to type one digit per box, on the reasoning that *"a
person types far too slowly to reach it, and a real paste or an iOS
one-time-code autofill goes down the spread branch and is unaffected — which is
why this is fixed here rather than in the app."* The second half of that has
now been contradicted by a real report. The consequence worth noting: **the
existing Maestro flow cannot catch this class of bug, because it was
deliberately shaped to avoid the branch the bug lives in.**

**Structural fix direction:** one TextInput owning the whole six-character
string, six non-input Views rendering the digits. No cross-field focus moves, no
per-box native text to desync, autofill lands in the one field that owns the
value. That makes all three defects impossible rather than merely detectable.

## The redesign did not cause this. It made it visible.

`403ac5e` ("rebuild the sign-in screens on Nocturne") changed exactly one string
literal in `mobile/app/sign-in.tsx` — `"Email me a code"` → `"Email me a 6-digit
code"`. The digit-box logic, the `codeBox` styles and the `KeyboardAvoidingView`
all date to `480074e` / `edee268` in August.

What Nocturne did change is contrast. `shadow.sm` went inert
(`shadowOpacity: 0`, `a784b81`) on the rule that on a dark ground elevation is
an edge — so edges became the primary visual device, at:

| | before | after |
|---|---|---|
| codeBox border on its fill | 1.54:1 (#D4C9BA on #FBF8F3) | 2.43:1 (#595D6C on #1F2130) |
| card border on bg | 1.19:1 (#E6DFD4 on #F6F2EA) | 1.76:1 (#3F424D on #161826) |

A 1px line at 1.5:1 against near-white can lag 100ms and nobody sees it. The
same line at 2.4:1 on #1F2130 is a visible object arriving late.

## What is NOT established

**None of this was reproduced.** Every claim above is read off source on disk,
which is stronger than a theory but is not an observation. No iOS device or
simulator is reachable from a Cowork session: `device_bash` runs in an isolated
**Linux** VM on the Mac, with no Xcode and no `xcrun`, and the cloud container
has neither.

The only real-iOS environment this repo has is CI — the "iOS e2e (simulator)"
job in `.github/workflows/ci.yml`, `macos-15`, booting a simulator with
`xcrun simctl` and driving Maestro. To reproduce there:

- **Border lag:** `xcrun simctl io "$UDID" recordVideo` across the tap that
  focuses `signin-code-0`, then compare border and glyph position frame by
  frame. Run it twice, once with `overflow: 'hidden'` on `codeBox`, as the
  A/B that confirms or kills section 1.
- **Digit spread:** a flow using Maestro's `pasteText` — **not** `inputText`,
  which types character by character and takes the wrong branch — into
  `signin-code-0`, then assert each of `signin-code-0..5` holds exactly one
  digit. That is the assertion the current flow was rewritten to avoid making.

## Reproduction results (2026-09-08, iPhone 17 Pro simulator, iOS 26.5, Release build)

Driven with `scripts/ios-e2e-local.sh` against the local server, Maestro
2.10.0, the app built from `e192933`. Every claim below is an observation.

### Symptom 1 — border lag: NOT reproduced

Setup: five digits pasted into the boxes, keyboard dismissed by tapping the
title, then `tapOn: signin-code-0` under `xcrun simctl io recordVideo`. The
recording was measured with `scripts/sim-frames.swift` (one pixel column
through the centre of box 0, x = 193 px; the top row of the box's border colour
against the top row of the digit "2" inside it, per frame).

The keyboard rise moved box 0 from y = 885 to y = 423 (462 px) over 29
frames, ~380 ms, 15–21 px per frame. **The glyph-to-border offset was 55 or
56 px in every one of those frames** — ±1 px, which is compression jitter, and
the same value it holds at rest before and after. The border did not trail the
fill or the text by a single frame. Excerpt (`f<frame> t=<ms>`):

```
f134 t=11401 border=885 glyph=940 glyph-border=55   (at rest, keyboard down)
f135 t=11408 border=877 glyph=933 glyph-border=56
f140 t=11476 border=800 glyph=856 glyph-border=56
f150 t=11588 border=659 glyph=715 glyph-border=56
f160 t=11740 border=478 glyph=534 glyph-border=56
f163 t=11790 border=423 glyph=478 glyph-border=55   (at rest, keyboard up)
```

The source lines cited in section 1 are all real in RN 0.81.5 on disk
(`_borderLayer.frame = self.layer.bounds` at `RCTViewComponentView.mm:559`
with no guard; `LayoutAnimation.configureNext` at
`KeyboardAvoidingView.js:171`; the `useCoreAnimationBorderRendering` test at
`:884`). What they predict — a 0.25 s implicit animation on the border layer
while the view moves on the keyboard curve — does not happen on the
simulator. Per the rule in this file's own prompt, that kills the hypothesis
as stated; the `overflow: 'hidden'` A/B was not run because there is no
divergence for it to remove. **What this does not rule out:** a real device.
The simulator's CoreAnimation runs on the Mac's GPU at the recording's 60 Hz;
a ProMotion iPhone at 120 Hz with UIKit's own keyboard curve is a different
compositor, and the report came from a device. If it is still visible on a
device, the next measurement is the same tool on a device screen recording,
not another reading of the source.

### Symptom 2 — six digits in box 0: NOT reproduced by any path the simulator offers

- **Edit-menu Paste of the real six-digit code** (long-press box 0 → Paste):
  the spread worked. Frame 252 of the recording shows `0 2 8 8 5 3` across the
  six boxes with "Verifying…", and the code signed in. What DID hold is
  defect (a): the keyboard stayed up through "Verifying…", because the
  `blur()` on box 5 is a no-op (box 0 was the first responder).
- **Edit-menu Paste of five digits** (no auto-submit, so the boxes could be
  read back through the accessibility tree): `BOXES=[2|4|6|8|0|]`. Correct.
- **Five digits typed at XCTest speed into box 0** (`inputText: '24680'`, the
  per-character branch and the race `sign-in.yaml` documents): also
  `[2|4|6|8|0|]`. The `8 0 8 8 8 _` race did not reproduce on this build.
- **A wrong six-digit paste** was rejected by the server and the boxes cleared
  before any readback could run (~500 ms); no intermediate state observed.
- **The keyboard's own suggestion — the path in the report — cannot be driven
  here.** The number pad has no QuickType bar in the simulator, and the
  edit-menu AutoFill item offers Contact, Passwords, Credit Card and Scan Text
  only: there is no one-time-code source (Messages or Mail) on a simulator.
  So defect (b), the dropped JS rewrite when native has emitted a newer text
  event, remains untested, and it is the one that fits the report — a correct
  submit with a wrong display needs JS state right and native text stale,
  and a single-event paste (which is what the menu produces, and what worked)
  never puts the two out of step.

**What would reproduce (b):** a real device with the code arriving by Mail or
Messages autofill, i.e. the exact path in the report. Alternatively a unit of
`RCTTextInputComponentView` behaviour is not reachable from JS tests.

### What this means for the fix

Nothing in the app has been changed. The structural fix proposed above — one
`TextInput` owning the whole string, six `View`s rendering the digits — is
still the right shape because it removes defect (a) (observed) and makes (b)
and (c) impossible regardless of whether they reproduce; but landing it on the
strength of a report that could not be reproduced is a judgement call for the
owner, not for this write-up. The existing Maestro flow still cannot see any
of this, and a paste-path flow needs the pasteboard set from the runner
(`xcrun simctl pbcopy`) — the flows used here were temporary and are not
committed.
