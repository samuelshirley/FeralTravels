# 05 — Planning loading UX + dog fetch video

**Size:** Small/Medium · **Risk:** Low · **Pairs with:** 04

**Idea (Sam):** when Penny is on a long planning turn, replace the bare 3-dots with a friendly "I'm doing some planning" state and a ~30s video of the dogs playing fetch, so the wait feels intentional. Asset: Sam to upload (~30s fetch clip).

## Where it lives
The long wait is the **post-onboarding replan turn** (Penny building the whole trip), and — once doc 04 lands — the chained auto-continue turns. This is a **ChatPanel loading state**, not an onboarding step. Today ChatPanel signals activity via `onActivity?.('fuel-planning' | 'planning')` and renders the typing dots; hook the new state in there.

## Build
1. Add the video asset to `public/` (e.g. `public/penny-planning.mp4`, poster image for fast first paint). Keep it small/compressed; loop or hold last frame if planning runs past 30s.
2. New `PennyPlanningLoader` component: short copy line ("Give me a sec — mapping your route and finding fuel…") + the video below, with the 3-dots still present so it reads as "thinking, with a video," not "a video instead of progress."
3. Trigger it when a replan turn is in flight **and** expected to be long. Heuristic: show after a short delay (e.g. >2.5s elapsed) so quick edits keep the lightweight dots; or always-on for the first full-trip build + any auto-continue chain.
4. Respect reduced-motion / no-autoplay: muted + `playsInline` + `autoplay`; fall back to poster + copy if blocked.

## Guardrails
- Don't block input or imply the user must watch.
- Don't ship a heavy asset that hurts mobile load — compress, lazy-load, poster first.

## Done when
- Long planning turns show the loader + video; short edits keep the plain dots.
- Works muted/autoplay on mobile, degrades to poster.
- `npm run test` + `tsc --noEmit` pass.

> Awaiting asset from Sam. Stub with the poster + copy until the clip lands so the rest can ship.
