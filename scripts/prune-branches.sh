#!/usr/bin/env bash
#
# Delete branches whose work is already in main. Local and remote.
#
#   npm run prune-branches            # dry run — prints the plan, deletes nothing
#   npm run prune-branches -- --apply # actually delete
#   npm run prune-branches -- --apply --keep feature/ios-app --keep wip/whatever
#
# DRY RUN BY DEFAULT, like `trial-account`. A branch is cheap to keep and
# expensive to recreate from a reflog you have to go looking for.
#
# THE SAFETY RULE, and it is the only one that matters: a branch is deleted
# ONLY if `git rev-list --count origin/main..<branch>` is 0 — every commit on it
# is already reachable from origin/main. That is not a heuristic about names or
# dates, it is the question "would deleting this lose a commit?", and it answers
# no. Anything with even one unmerged commit is REPORTED and left alone,
# including branches whose content was squashed into main under a different sha
# (those look unmerged to git, and telling the difference needs a human who
# knows what they were for).
#
# Which is also what makes this safe to run while somebody else — another agent,
# another worktree, a teammate — is mid-change: their unpushed work is by
# definition unmerged, so it lands in the report, not in the delete list. Pass
# --keep for anything you want skipped even when it IS merged.
#
# Never touched: main, the branch you are on, and anything checked out in
# another worktree (git refuses that itself).
set -euo pipefail

APPLY=0
KEEP=("main")

while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1; shift ;;
    --keep)  KEEP+=("$2"); shift 2 ;;
    -h|--help) sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

CURRENT="$(git rev-parse --abbrev-ref HEAD)"
KEEP+=("$CURRENT")

kept() { local b="$1"; for k in "${KEEP[@]}"; do [ "$b" = "$k" ] && return 0; done; return 1; }

echo "Fetching…"
git fetch --prune origin >/dev/null 2>&1
BASE="origin/main"
echo "Base: $BASE ($(git rev-parse --short "$BASE"))"
echo "On branch: $CURRENT"
echo

MERGED_LOCAL=(); MERGED_REMOTE=(); UNMERGED=(); SKIPPED=()

for b in $(git for-each-ref --format='%(refname:short)' refs/heads/); do
  if kept "$b"; then SKIPPED+=("$b"); continue; fi
  if [ "$(git rev-list --count "$BASE..$b")" -eq 0 ]; then
    MERGED_LOCAL+=("$b")
  else
    UNMERGED+=("local  $b ($(git rev-list --count "$BASE..$b") unmerged)")
  fi
done

for r in $(git for-each-ref --format='%(refname:short)' refs/remotes/origin/ | grep -v 'origin/HEAD$\|origin/main$'); do
  b="${r#origin/}"
  if kept "$b"; then SKIPPED+=("origin/$b"); continue; fi
  if [ "$(git rev-list --count "$BASE..$r")" -eq 0 ]; then
    MERGED_REMOTE+=("$b")
  else
    UNMERGED+=("remote $r ($(git rev-list --count "$BASE..$r") unmerged)")
  fi
done

echo "MERGED — safe to delete (${#MERGED_LOCAL[@]} local, ${#MERGED_REMOTE[@]} remote):"
for b in "${MERGED_LOCAL[@]}";  do echo "    local   $b"; done
for b in "${MERGED_REMOTE[@]}"; do echo "    remote  origin/$b"; done
[ ${#MERGED_LOCAL[@]} -eq 0 ] && [ ${#MERGED_REMOTE[@]} -eq 0 ] && echo "    (none)"

if [ ${#UNMERGED[@]} -gt 0 ]; then
  echo
  echo "NOT TOUCHED — carries commits that are not in $BASE:"
  for u in "${UNMERGED[@]}"; do echo "    $u"; done
  echo
  echo "  Some of these are duplicates whose content reached main under a different"
  echo "  sha (a squash, or the same patch committed twice on two branches). git"
  echo "  cannot tell those from real work — check with:"
  echo "      git log --oneline $BASE..<branch>"
  echo "      git diff $BASE...<branch>        # empty diff = content already in main"
  echo "  and delete by hand if the diff is empty."
fi

if [ ${#SKIPPED[@]} -gt 0 ]; then
  echo
  echo "KEPT by request / current branch: ${SKIPPED[*]}"
fi

if [ "$APPLY" -eq 0 ]; then
  echo
  echo "DRY RUN — nothing deleted. Re-run with --apply to delete the MERGED list."
  exit 0
fi

echo
for b in "${MERGED_LOCAL[@]}";  do echo "deleting local  $b";        git branch -d "$b"; done
for b in "${MERGED_REMOTE[@]}"; do echo "deleting remote origin/$b"; git push origin --delete "$b"; done
echo
echo "Done. $(( ${#MERGED_LOCAL[@]} + ${#MERGED_REMOTE[@]} )) branch refs removed."
