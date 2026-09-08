# Claude Code prompt — the onboarding flash, the first-run type scale, and the trial line

Three items, all in the first-run chat. 1 is a render-order bug I have already reproduced. 2 is
the design consequence of 1 — the screen that flashes is the one Sam wants. 3 is a copy move
that falls out of 2.

**Before writing a single line of fix: reproduce 1 and 2 in a real browser with the Playwright
MCP**, on a first-run account (`createOnboardingTrip` in `e2e/fixtures/test-trip.ts`, *not*
`seedCanonicalFixture` — a seeded complete vehicle skips steps). The cause in item 1 is
confirmed by a failing test (below); items 2 and 3 are unverified design/copy work, so watch
them on screen before and after.

---

## 1. The first-run chat paints the `START HERE` empty state, then throws it away

**Observed (Sam, web, iPhone):** landing on a new trip flashes the big-type empty state — the
`START HERE` kicker, the 19px "Tell Penny where you're going and how far you want to drive each
day." headline and the quoted starter rows — and then replaces it with the onboarding card:
Penny's greeting in a 14px bubble, the `TAP TO START, THEN EDIT` kicker, the city row and the
prompt rows.

**Reproduced, not theorised.** `src/components/ChatPanel.onboardingFlash.test.tsx` (left in the
repo, currently red) renders `ChatPanel` with `onboardingState="trip_intent"`, an empty
`initialMessages` and an `apiFetch` that resolves the snapshot one macrotask later:

```
[repro] START HERE painted on first render: true
AssertionError: START HERE must not paint during onboarding: expected true to be false
```

**Cause.** The empty state is gated on `onboardingUiActive`
(`src/components/ChatPanel.tsx:2413`), and `onboardingUiActive` requires a snapshot that has not
arrived yet (`:479-483`) — the snapshot is fetched in a `useEffect` after mount (`:843-866`), so
on the *first* render it is always `null` and the gate is always open. The window is not one
frame either: after the fetch resolves, `introTyping` holds the greeting back another 3000 ms on
the first question (`:897-905`), so the wrong screen is the whole visible first-run experience
until the card lands.

Identical on native: `mobile/components/ChatPanel.tsx:1703`, same `!onboardingUiActive` gate,
same effect at `:396-398`.

**Fix (validated).** Adding `&& !isOnboarding` to the gate at `src/components/ChatPanel.tsx:2413`
turns the repro green — `isOnboarding` is known synchronously from the prop, so nothing races.
Mirror it on native. But do not stop at the boolean: decide what the pane shows during
`onboardingBlockingLoad` (the composer already says "Loading setup…"; the transcript above it
would now be blank for the fetch *plus* the 3s typing delay), and check the `onboardingError`
path — today a failed snapshot leaves the starter block standing, and after this change it
leaves nothing.

---

## 2. The screen that flashes is the one that should stay

Sam wants the first-run screen to read like the flash and like frame 7i in the Nocturne set: a
full-width headline block, not Penny's message crammed into a chat bubble with a tight card
under it. That design frame is the *on-trip* empty state, so this is an adoption of its type
scale, not a copy of its content — the greeting text and the `1 OF 5` progress counter stay.

Take the empty-state treatment (`src/components/ChatPanel.tsx:2415-2459`) as the reference:
kicker 9.5px / 600 / 0.13em, headline 19px / 500 / 1.3 line-height with `text-wrap: pretty` and
16px beneath it, rows 12–14px padding with an 8px gap. The onboarding card today is tighter
throughout — greeting at 14px inside `bubbleAssistant`, kicker at 0.12em, prompt rows at 11/14px
padding with a 6px gap (`:2100-2140`, and `mobile/components/ChatPanel.tsx:2326-2368`).

Apply it to the `trip_intent` step only — the step that is somebody's first screen. Keep the
city row (`Name a city — Lisbon, Girona, Tromsø…`) and the two prompt rows, keep their prefill
behaviour, keep the progress counter in the header, and leave steps 2–5 as bubbles: they are a
conversation by then and a headline per question would be shouting. Native mirrors web.

---

## 3. Move the trial line out of the greeting and onto the build message

Once the greeting is a headline, `Welcome to your seven-day free trial.` is the first and largest
thing a new user reads, ahead of the question. Sam wants it on the *last* message of onboarding
instead — the caption on the dog-fetch clip when the trip starts building:

> Building this trip now, you have 7 more days on your free trial.

- Drop the prefix from the greeting: `withTrialWelcome` in `src/server/onboarding.ts:593-605`.
- Add it to the planning caption: `PLANNING_VIDEO_COPY`, `src/components/ChatPanel.tsx:83-84`
  and `mobile/components/ChatPanel.tsx:98-103`. It is client-side, so the day count is already
  to hand — `entitlement.trialDaysRemaining` (`src/types/entitlement.ts:67`). Make the caption a
  function of the entitlement rather than a constant, and keep the existing string verbatim for
  everyone not on a trial.
- Handle the tails: 1 day ("this is the last day of your free trial"), 0/expired, a subscriber
  and a comped account each read no trial line at all. `trialWelcomeLine`
  (`src/server/payments/copy.ts:72-76`) already spells the number and owns those branches —
  reuse or move it rather than writing a second speller, and keep `src/lib/paywallCopy.test.ts`
  passing.
- `isTripIntentLabel` matches the greeting on its *tail* precisely because of the old prefix
  (`src/lib/onboardingForm.ts:130-135`). With the prefix gone, decide whether that stays — and
  if it does, say why in the comment, because the reason it gives will no longer be true.

---

## Guards

- Keep `src/components/ChatPanel.onboardingFlash.test.tsx` as the regression guard for item 1,
  rewritten to your final shape (it is scaffolding, not house style). Mutation-check it:
  put the old gate back and watch it go red.
- `e2e/onboarding-flash.repro.spec.ts` is a Playwright sketch of the same assertion via a
  `MutationObserver` installed with `addInitScript` — **it has never been run** (I could not
  execute the toolchain). Either make it work as part of the onboarding spec or delete it; do
  not leave an unexecuted spec in `e2e/`.
- Item 2 needs a screenshot pair on the preview build, not just green tests.
- Both surfaces every time, and `npm run check:shared` / `npm run sync-shared` for the
  `onboardingForm` mirror.
- `docs/bugs/_to_delete/ft-src.tgz` is a source tarball I made to run the repro off-machine.
  Delete it.
