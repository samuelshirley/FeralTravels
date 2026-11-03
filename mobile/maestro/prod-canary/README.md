# Production canary flows — NOT part of the CI suite

These run against **production**, from `scripts/prod-canary-ios.sh` on Sam's Mac,
signed in as `samuelashirley+canary-ios@gmail.com`. They live in this
subdirectory so that the shard guard (`src/lib/maestroFlowParams.test.ts`,
which reads only `mobile/maestro/*.yaml`) never puts them in a CI shard: a PR
run must never touch the production database.

The sign-in is the real one and nothing is seeded — `/api/test/*` is hard-off on
production. So the run is split in two at the code:

1. `request-code.yaml` — fresh install, type the address, ask for a code.
2. The runner waits for `tmp/prod-canary-ios/run/code`, which the scheduled
   Claude task writes after reading the email from Gmail.
3. `plan-trip.yaml` — type the code, run onboarding to the hand-off
   (Girona → Barcelona), send the low-tank message, check the itinerary shows
   a Google fuel stop and the map draws, then delete every trip on the account.

Why, and what each check proves: `docs/design/prod-canary.md`.
