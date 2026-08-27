#!/usr/bin/env bash
#
# Opens the one-pipeline + spring-cleaning PR, then deletes the merged branches.
# Verifies before it commits and stops on the first failure. Deletes itself when
# it succeeds.
set -euo pipefail
cd "$(dirname "$0")"

echo "==> clearing stale git locks"
find .git -maxdepth 1 -name 'index.lock*' -delete || true

echo "==> branching off a fresh main"
git fetch origin
git checkout -b ci/one-pipeline origin/main

echo "==> installing the pipeline (the bridge cannot write under .github/workflows)"
mkdir -p .github/workflows
mv -f pipeline.yml.new .github/workflows/pipeline.yml
rm -f mobile-workflow.new.yml restructure-pr9.sh

echo "==> retiring the four old workflows"
git rm -q .github/workflows/ci.yml .github/workflows/deploy-production.yml \
          .github/workflows/mobile.yml .github/workflows/pr-cleanup.yml

echo "==> folding docs/future-features into docs/future"
git mv docs/future-features/carplay-driving-companion.md docs/future/carplay-driving-companion.md
git mv docs/future-features/penny-location-awareness.md  docs/future/penny-location-awareness.md
rmdir docs/future-features 2>/dev/null || true

echo "==> verifying"
npm run test
npx tsc --noEmit
(cd mobile && npx tsc --noEmit)

commit () { git commit -q -m "$1" -m "$2"; }

echo "==> 1/2 the pipeline"
git add .github/workflows/pipeline.yml README.md CLAUDE.md \
        docs/design/mobile-release.md docs/design/app-store-listing.md \
        scripts/assert-e2e-ran.mjs e2e/fixtures/constants.ts e2e/login-otp.spec.ts
commit "ci: one pipeline — open a PR, merge it, it is live everywhere" \
"Four workflows become one. Not for tidiness: deploy-production.yml and
mobile.yml both fired on push to main with nothing sequencing them, so a mobile
OTA could reach a phone before the API it expects had deployed. Mobile now runs
needs: deploy.

One file, four triggers, and the merge button is the only control:

  pull_request         unit, mobile typecheck, preview, e2e
  push: main           migrate + deploy prod, then mobile
  pull_request closed  delete the PR's Neon branch
  workflow_dispatch    force a mobile OTA or native build by hand

The one thing that could not be collapsed is that tests run BEFORE the merge.
That is what makes merging safe to be automatic — a suite that ran on main would
already be migrating production before it caught anything.

Job names are unchanged, so branch protection keeps working: Unit tests, Deploy
tested preview, E2E tests (against preview). Mobile typecheck still runs
alongside and deliberately does not gate.

Also carries the fingerprint fix. The OTA target check asked \"is there a build
at this runtimeVersion\", which answered yes for two builds predating PR #7 — no
CFBundleURLScheme, no usesAppleSignIn — so the OTA switched both sign-in buttons
on in binaries that cannot complete either flow. It now compares native
fingerprints (main is ad7c05af, those builds are f407a3a7) and escalates to a
native build when nothing matches. A merge touching nothing under mobile/
produces no mobile release at all.

And rewrites app-store-listing.md section 6, which still listed account deletion
and native OAuth as submission blockers. Both shipped.

The trade, stated plainly: four files failed independently, one file fails all at
once. A YAML mistake here takes the gate and the deploy down together."

echo "==> 2/2 spring cleaning"
# The two doc moves are already staged in full by `git mv` above.
git add -A tsconfig.json mobile/package.json docs/design/pr7-review-and-test-plan.md docs/future
commit "chore: sweep the config and docs that no longer describe the repo" \
"Four things that were quietly wrong rather than merely untidy.

tsconfig excluded _graveyard and _to_delete. Neither directory exists.

mobile/package.json's sync:shared has never worked: it ran
\`node ../scripts/sync-shared.mjs\` with cwd mobile/, and the script resolves its
paths against cwd, so it exited 1 on the first file. Only the root script ever
ran — which is the same class of bug as the sync script itself being broken
before PR #7 found it. Now \`cd .. && node scripts/sync-shared.mjs\`, verified.

docs/future-features/ and docs/future/ were two directories for one idea. Folded
into docs/future/; nothing referenced the old path.

pr7-review-and-test-plan.md read as an untouched backlog when Tiers 1 and 2
shipped in PR #9. A plan document that overstates what is left costs the same as
one that understates it — see app-store-listing.md section 6, which claimed
account deletion was still a submission blocker in the commit that shipped it.
Status header added rather than deleting the file: Tiers 3 to 5 are real work."

# Catches the class of mistake that would otherwise ship a half-staged branch:
# anything tracked and still modified means a path was missed above.
if ! git diff --quiet; then
  echo "!! tracked changes are still unstaged — nothing pushed:"
  git status --short
  exit 1
fi

echo "==> pushing"
git push -u origin ci/one-pipeline
gh pr create --fill

echo
echo "==> deleting branches already merged into main"
for b in chore/ci-job-names chore/deploy-is-merge chore/eas-config ci/pr-pipeline \
         feat/native-oauth feature/ios-app feature/ios-parity test/pr7-coverage; do
  if git merge-base --is-ancestor "origin/$b" origin/main 2>/dev/null; then
    echo "  deleting $b"
    git push origin --delete "$b" || echo "  (already gone)"
  else
    echo "  SKIPPED $b — not merged into main"
  fi
done
git remote prune origin

rm -f "$0"
echo
echo "==> done"
git log --oneline origin/main..HEAD
