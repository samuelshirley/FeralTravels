#!/usr/bin/env bash
# Hand a task brief under docs/tasks/ to Claude Code as its opening prompt.
#   scripts/claude-task.sh docs/tasks/2026-09-09-haiku-fuel-tankwalk.md
set -euo pipefail
cd "$(dirname "$0")/.."
brief="${1:?usage: scripts/claude-task.sh docs/tasks/<brief>.md}"
[ -f "$brief" ] || { echo "no such brief: $brief" >&2; exit 1; }
command -v claude >/dev/null || { echo "claude (Claude Code CLI) is not on PATH" >&2; exit 1; }
exec claude "Carry out the task brief at $brief in full. Read it and CLAUDE.md before doing anything else, then start at section 1."
