# Handoff — iOS e2e job: three cheap speed-ups, no change to what is tested

Small, additive follow-on to whatever you are doing about the current `iOS e2e (simulator)`
failure. **Land the failure fix first.** These are wall-clock savings only; none of them may
change what the flows exercise, and if any one of them makes a green run go red or ambiguous,
drop it and say so rather than working around it.

Scope is exactly the three items below. Do **not** add a build cache for the `.app` — one was
there and was removed on purpose (`.github/workflows/ci.yml:709-724`): a cache hit skipped the
JS bundle too, so the simulator would launch an app pointed at a previous PR's dead preview
URL. That is a separate piece of work with a real design to it, and it is not this task.

## 1. Cache the Maestro install

`Install Maestro` (`ci.yml:813-820`) curls `get.maestro.mobile.dev` and unpacks into
`~/.maestro` on every run, for a version that is **pinned** (`MAESTRO_VERSION: 2.10.0`). That
is a download of a fixed artifact — the ideal cache.

Wrap it in `actions/cache` keyed on the runner OS + the pinned version (something like
`maestro-${{ runner.os }}-2.10.0`), path `~/.maestro`, and keep the `PATH` export and the
`maestro --version` line **outside** the cache block so a restored install is still put on the
path and still prints its version into the log. Read the version from one place rather than
retyping it into the key — a key that silently disagrees with the pin is a cache serving the
wrong Maestro, which is the failure mode this job is least equipped to explain.

Related, worth a line in the same commit if it is cheap: `scripts/ios-e2e-local.sh:73` carries
`MAESTRO_PIN="2.10.0"` and `ci.yml:815` carries `MAESTRO_VERSION: 2.10.0` as two independent
literals. They pair with the Xcode selected at `ci.yml:~805` (Maestro ships a **prebuilt**
driver built with Xcode 26.2). If they can share one definition without contorting the YAML,
do it; if not, leave a comment on each pointing at the other. Do not bump either version here.

## 2. Stop the simulator build producing things nothing reads

The `xcodebuild` call is `ci.yml:729-733`. It builds a Release simulator app that exists only
to be installed on one booted simulator in this same job, and then discarded. Add:

- `ONLY_ACTIVE_ARCH=YES` — the runner is Apple Silicon and the simulator is arm64; a second
  slice is compiled and thrown away. **Verify the runner's arch on a real run before claiming
  the saving** — if `macos-15` gives you an Intel host this does nothing.
- `COMPILER_INDEX_STORE_ENABLE=NO` — the index store feeds Xcode's editor. There is no editor.
- `DEBUG_INFORMATION_FORMAT=dwarf` — skips dSYM generation. Nothing here symbolicates a crash
  from CI; the flows fail on selectors and screenshots.

Leave `-configuration Release` alone — `ci.yml:735-760` explains at length why Debug produces
an app with no JavaScript at all. Do not add `-quiet` unless you check what the current log
actually gives you on a failure first; a quieter build log is a worse one the day it breaks.

## 3. Measure it, and say what you measured

Before/after wall-clock for the `Install Maestro` and `Build the app for the simulator` steps,
from real runs, not from reasoning about what should be faster. If a change saves nothing
measurable, revert it — an unexplained flag in a build invocation costs more later than the
seconds it did not save.

## While you are in this file — two comments that now lie

Not part of the speed work; fix them because you are here and they will mislead the next
person.

- `ci.yml:660` and `ci.yml:690` both still state the built `.app` is cached against a native
  fingerprint. It is not — the step below them says so itself.
- `CLAUDE.md`'s iOS E2E paragraph is stale in the same two ways: it says the job "runs only
  when something under `mobile/` changed" (the diff gate was removed 2026-08-28,
  `ci.yml:680-693`) and that it "caches the built `.app` against a NATIVE fingerprint".

Correct both to describe the job as it is. Same commit as the speed changes is fine.
