# docs/future/

Design docs for features that are deferred but worth picking up later. Each file should:

1. State **why it's deferred** (usually: low frequency, or blocked on some other work).
2. Capture **all the design conversation** so a cold reader (probably future-Sam) can pick it up without re-deriving everything.
3. Include a **resumption checklist** — what to do first when picking it back up, in order.

Current contents:

- [`height-aware-routing.md`](./height-aware-routing.md) — truck/RV/tall-van routing that respects low bridges. Deferred because the feature is high-severity but low-frequency; most tall-vehicle miles are on motorways where it doesn't matter.
