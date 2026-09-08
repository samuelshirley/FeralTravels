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
