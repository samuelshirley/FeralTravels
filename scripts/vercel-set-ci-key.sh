#!/usr/bin/env bash
# Put ANTHROPIC_API_KEY_CI into the Vercel PREVIEW and DEVELOPMENT environments,
# reading the value from .env — never from the command line, never pasted.
#
# Why (measured 2026-09-09 with scripts/anthropic-usage-report.ts): the key
# split in src/lib/anthropicKey.ts shipped on 2026-09-08 but the Vercel Preview
# environment was never given ANTHROPIC_API_KEY_CI, so anthropicKey() fell
# through to ANTHROPIC_API_KEY — the PRODUCTION key. Six preview deployments
# between 14:30 and 15:08 UTC that day billed ~$1.34 to the production key with
# no prod usage_events row to show for it, and the CI key had zero usage ever.
# Deliberately NOT production: the whole point is that prod never sees this key.
#
# Needs `vercel login` once on this machine (the CLI is a devDependency).
set -euo pipefail
cd "$(dirname "$0")/.."
value=$(grep -E '^ANTHROPIC_API_KEY_CI=' .env | head -1 | cut -d= -f2- | sed -e "s/^['\"]//" -e "s/['\"]$//")
if [ -z "$value" ]; then
  echo "ANTHROPIC_API_KEY_CI is empty or missing in .env" >&2
  exit 1
fi
for env in preview development; do
  # `vercel env rm` first so a re-run replaces rather than fails on "already exists".
  npx vercel env rm ANTHROPIC_API_KEY_CI "$env" --yes >/dev/null 2>&1 || true
  printf '%s' "$value" | npx vercel env add ANTHROPIC_API_KEY_CI "$env"
done
echo
echo "Now set on preview + development. Verify:"
npx vercel env ls preview | grep ANTHROPIC || true
echo "The next PR push will bill the CI key; check with: npx tsx scripts/anthropic-usage-report.ts"
