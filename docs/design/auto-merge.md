# Auto-merge — continuous deployment

Sam's decision, 2026-10-01: **every open PR merges itself into `main` once its
tests have passed, AI tests included**, and every other open PR is then brought
up to date. Merging is deploying (`deploy-pipeline.md`), so from the moment
`AUTO_UPDATE_TOKEN` exists a green PR reaches production with nobody looking.

**Except a PR that needs a new iOS build** (Sam, 2026-10-02: *"The only things
that shouldn't auto merge are if it requires a new build for iOS — only
continuous delivery for over-the-air changes."*):

- **Auto-merges:** a PR that changes nothing under `mobile/`, or whose mobile
  changes ship over the air (JS only, an EAS Update).
- **Does not:** a PR that needs a new iOS binary — a dependency or lockfile
  change, `app.config.js`, `eas.json`, app assets, an install/EAS build hook.
  The bot posts one comment saying so, adds no `ai-tests` label (no Penny
  spend) and never merges it; it still brings it up to date with main after
  every merge. **Merge it by hand** when you are ready for the TestFlight
  build (`mobile-release.md`).

- Workflow: `.github/workflows/auto-merge.yml`
- Logic: `.github/scripts/auto-merge.mjs` (pure rules + a thin `gh` layer)
- Tests: `src/lib/autoMerge.test.ts`

## What merges, and when

A PR merges when ALL of these hold:

1. Merging it needs no new iOS binary (below).
2. It is open, not a draft, targets `main`, comes from this repository (never
   a fork: the token can write here, so fork code is never what it merges), and
   has no `hold` label.
3. Its latest CI run is for its CURRENT head commit and concluded `success`.
   A run for an older head (the PR was pushed since), a re-run of an older run,
   or a run superseded by a newer one on the same commit decides nothing.
4. It changes no app code, or it changes a test too, or it carries
   `no-tests-needed` (below).
5. It is not behind `main` and does not conflict with it.
6. It is docs-only (CI skipped `Deploy tested preview`), or the AI shard
   (`iOS e2e · ai`) has passed on some CI run for this head commit.

The merge is a merge commit (`gh pr merge --merge`, the repo's style) pinned to
the tested head (`--match-head-commit`), so a push that lands in between is
never merged untested.

### How "needs a new iOS build" is decided

The same classifier the Mobile workflow uses, `scripts/decide-mobile-release.mjs`
(tested by `decideMobileRelease.test.ts`), with the same inputs as mobile.yml's
PR forecast: `git merge-base main <PR head>` → PR head, `--json`. Its answer is
`none`, `js-only` or `native`; only `none` and `js-only` auto-merge.

`after-ci` checks out **main's** copy of the bot and the classifier (sparse,
full history, `persist-credentials: false`), fetches the PR head commit as git
objects only — anonymously, the repo is public — and runs the classifier on it
before the bot. Nothing from the PR is checked out, installed, imported or run;
`autoMerge.test.ts` fails if that job ever gains an npm/npx/install or a
checkout of the PR.

**It fails safe to native.** A fetch that fails, no merge-base, a classifier
that errors, no output, unparseable output, or a decision that is not one of the
three: each is treated as `native`, says why in the job log and on the PR, and
the PR waits for a person. A PR wrongly held costs a manual merge; a native
change wrongly merged would publish JS to binaries that cannot run it.

**The comment** (`<!-- auto-merge:native -->`) says the PR needs a new iOS
build, so it will not merge itself, and lists the classifier's reasons. It is
edited in place if the reasons change, and deleted once a later head is no
longer native — that head then goes through the normal rules. `update-open-prs`
still brings native PRs up to date with main after every merge, which keeps
them mergeable for when you merge them.

## What happens on each CI run

`after-ci` runs when CI completes green. In this order, so Penny is spent last:

| PR state | Action |
|---|---|
| needs a new iOS build (or the classifier could not say) | one sticky comment with the reasons; nothing else |
| app code, no test, no `no-tests-needed` | one sticky comment listing the files; no merge |
| conflicts with main | one sticky comment: merge main in by hand |
| behind main | update-branch (merge main in) → CI runs again |
| needs the AI shard, never tried on this head | add `ai-tests` (removed first if present: a label already on a PR fires no `labeled` event) |
| AI shard already ran on this head and failed | nothing: push a fix, or remove and re-add `ai-tests` |
| ready | merge |

A PR that cannot merge anyway — a native one included — is not sent to the AI shard, because the commit
that fixes it needs its own AI run. A sticky comment is deleted once its
condition is gone.

**At most one automatic AI run per head commit.** The bot labels only when no
CI run for that commit has run the AI shard. A red or flaky AI run is never
retried by the bot. A *cancelled* one may be: any label or reopen starts a new
CI run that cancels the one in flight (ci.yml's concurrency), and only a person
causes that, so it cannot loop. CI's fail-fast (2026-10-02) is the other thing
that cancels an AI shard — another job failed — and it cannot loop either: that
run concludes `cancelled`, `after-ci` acts only on a green run, and the next
push is a new head with its own one attempt.

## After every merge

`update-open-prs` runs on every push to `main`, the bot's own merges included
(they are made with the PAT, so they start workflows). For every open,
non-draft, same-repo PR without `hold` that is behind main, it calls GitHub's
update-branch with `expected_head_sha`. A conflict gets the sticky conflict
comment once; a head that moved in the meantime is left to its own CI run; one
PR's error never stops the others. The job fails only if the token is rejected.

**Why update-branch and not a rebase:** agents are pushing to these branches.
A rebase is a force-push, and an agent's next push onto the rewritten branch
fails or, worse, restores the old history. Merging main in only adds a commit.

## Labels

- **`hold`** — Sam's brake. The PR is never merged or updated by the bot.
  Removing the label starts nothing (CI does not run on `unlabeled`): re-run the
  PR's latest CI run, or push, to put it back in the queue.
- **`no-tests-needed`** — waives the tests rule for a PR that genuinely needs
  none (a dependency bump, a copy fix). Adding it starts a CI run, which
  re-evaluates the PR.
- **`ai-tests`** — managed by the bot from now on; adding it by hand still
  works as before (ci.yml).

### The tests rule

App code is anything under `src/` or `mobile/`, except tests and markdown. A
test is `*.test.ts(x)`/`*.test.(m)js`, anything under `e2e/`,
`mobile/maestro/` or `src/test/`. A PR that changes app code and no test does
not merge. This was a habit (every feature PR added a Maestro flow and unit
tests) and nothing enforced it; with no human before production, it is now
checked. It is coarse on purpose — "a test changed", not "the right test" — and
the label is the escape hatch.

## The token

A label, branch update or merge made with the workflow's `GITHUB_TOKEN` starts
no workflows: CI would never run on an updated branch, the AI shard would never
start, and a bot merge would never deploy. So every write uses a fine-grained
personal access token:

- **Secret:** `AUTO_UPDATE_TOKEN` (repo → Settings → Secrets and variables →
  Actions, or `gh secret set AUTO_UPDATE_TOKEN -R samuelshirley/FeralTravels`).
- **Create it:** GitHub profile picture → Settings → Developer settings →
  Personal access tokens → Fine-grained tokens → Generate new token, for
  `samuelshirley/FeralTravels` only.
- **Permissions:** Contents, Pull requests, and Workflows — read and write.
  Workflows because update-branch writes a merge commit that can carry a
  changed workflow file, which GitHub refuses without it.
- **What it looks like:** the bot's labels, comments, merges and branch updates
  appear as Sam.
- **Reads** use the workflow's own `github.token` (`READ_TOKEN`), which has
  `actions: read`; the PAT is not given Actions. The script picks the token
  from the gh command itself, and anything it cannot prove is a read goes out
  with the PAT.
- **Without it** both jobs log a notice and exit 0: merging this workflow before
  the token exists changes nothing.
- **Expired or revoked:** the job fails red, naming the token.

## Why not merge queue or native auto-merge

- **Merge queue** is only available to organisation-owned repositories; this
  one is user-owned.
- **GitHub's native auto-merge** waits only for the REQUIRED checks — `Decide
  scope` and `Unit tests` — so it would merge before E2E and the simulator
  finish. Requiring more checks would fix the timing, but nothing in it
  starts the AI run, which only a label does.

## Concurrency

One run at a time per PR head commit (and one for pushes to `main`), never
cancelled. Not one repo-wide group: GitHub keeps a single pending run per group
and cancels the others, so with several PRs finishing CI together a green run
would be dropped and its PR would sit unmerged. Two parallel runs cannot merge
two PRs onto a stale main: branch protection requires a PR to be up to date
with main, so once one merges the other is behind and refused, and every merge
is pinned to its tested head commit. A merge that loses that race is a warning; the push-to-main job
updates the loser.

## Cost

Every PR head commit that gets this far runs the AI shard once — real Penny
planning (Anthropic) plus Directions and Places calls. **Every merge
updates every other open PR**, giving each a new head, so N open PRs cost
roughly N AI runs per merge. The ordinary CI run also re-runs per update
(a Neon branch and a Vercel preview each; macOS minutes are free on a public
repo). With many open PRs, `hold` the ones that are not ready.

## The deploy still re-verifies

Merging does not skip the gate. `deploy-production.yml` resolves the merge
commit to its PR head and requires the latest CI run for that head to be green,
waiting for one still running, before it migrates production and deploys
(`deploy-pipeline.md`). Branch protection on `main` is unchanged.

## Follow-ups (files owned elsewhere)

- `CLAUDE.md`'s Workflow section still says Sam pushes, opens the PR and merges.
