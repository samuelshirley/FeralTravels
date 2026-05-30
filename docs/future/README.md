# docs/future/

Design docs for features that are deferred but worth picking up later. Each file should:

1. State **why it's deferred** (usually: low frequency, or blocked on some other work).
2. Capture **all the design conversation** so a cold reader (probably future-Sam) can pick it up without re-deriving everything.
3. Include a **resumption checklist** — what to do first when picking it back up, in order.

Current contents:

- [`height-aware-routing.md`](./height-aware-routing.md) — truck/RV/tall-van routing that respects low bridges. Deferred because the feature is high-severity but low-frequency; most tall-vehicle miles are on motorways where it doesn't matter.
- [`penny-tool-surface.md`](./penny-tool-surface.md) — the planned set of external tools Penny should call (Maps routing, geocoding, weather, POI search, etc.) instead of hallucinating facts from training data. Reframes "agentic Penny" → tool-using Penny, with a small speculative section on a real multi-step agent loop gated on actual need.
- [`penny-tool-grounded-ui.md`](./penny-tool-grounded-ui.md) — render tool-call results as structured chat cards (RouteSummary, FuelStopOption, etc.) instead of letting Penny narrate the facts in prose. Sister project to `penny-tool-surface.md`: that doc is *which tools to add*, this one is *how to render their results*.
- [`native-app-rewrite.md`](./native-app-rewrite.md) — Expo + React Native rewrite for App Store presence and native-only features (offline tiles, background GPS, push). Deferred because we have zero users and the current PWA covers 80% of the value at 0% of the rewrite cost.
- [`preview-gated-deploys.md`](./preview-gated-deploys.md) — CI-orchestrated deploys: push to main → Vercel preview → Playwright in GitHub Actions → `vercel promote` on green. Designed to take the developer's local network out of the test-runner loop (the plane-wifi failure mode) and gate prod on a tested artifact. Deferred to solid-wifi day and ideally before first real user.
