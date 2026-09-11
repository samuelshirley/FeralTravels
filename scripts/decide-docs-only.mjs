#!/usr/bin/env node
/**
 * Is this pull request's diff DOCUMENTATION ONLY?
 *
 * `node scripts/decide-docs-only.mjs --files <path>` (or the list on stdin)
 * prints `docs_only=true` or `docs_only=false` on stdout in GITHUB_OUTPUT
 * format, and its reasoning on stderr. `--json` swaps stdout for
 * `{decision, docsOnly, reasons}`.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 *
 * A markdown-only PR was spending a Neon branch cloned from production, a
 * Vercel preview deploy, the full Playwright suite and an 18-minute macOS
 * simulator run to tell us nothing about a prose edit. The jobs gated on this
 * are the ones that deploy something or drive a browser; a docs diff cannot
 * change what either would find.
 *
 * ── The rule that is NOT obvious, and is the reason `unit` is not gated ────
 *
 * Markdown in this repo is not inert. `claudeMdGuard`, `decisionsRegisterGuard`,
 * `removedFeaturesGuard`, `googleAccountingGuard` and `oneGoogleKeyGuard` all
 * read CLAUDE.md or docs/decisions.md as TEXT and fail the unit suite on drift
 * — so a docs-only PR is exactly the kind that reds them. The unit job
 * therefore runs on every PR regardless of what this script says, and
 * `decideDocsOnly.test.ts` fails if anybody gates it.
 *
 * ── Fail-safe, in the same shape as decide-mobile-release.mjs ──────────────
 *
 * Every uncertain answer is `false` (run everything): an empty or unreadable
 * file list, a path this script has no opinion about, a file type invented
 * tomorrow. Being wrong towards `false` costs a preview deploy; being wrong
 * towards `true` ships untested code to production, because merging is
 * deploying and the deploy gate reads this workflow's conclusion.
 *
 * ── Why the workflow still RUNS on a docs-only PR ─────────────────────────
 *
 * `deploy-production.yml` resolves the PR a merge commit came from and requires
 * `gh run list --workflow CI --commit <head sha>` to be completed+success. A
 * trigger-level `paths-ignore` would produce NO run for that sha, the gate
 * would read "none", and the docs merge would leave production stale until
 * somebody re-ran the deploy by hand. So the trigger is untouched and the
 * expensive JOBS are skipped instead — a run with skipped jobs still concludes
 * `success`, which is what the gate reads.
 */

/** Paths that cannot change what a preview deploy, Playwright or tsc would find. */
function isDocPath(path) {
  if (path.endsWith('.md')) return true;
  if (path.startsWith('docs/')) return true;
  if (path === 'LICENSE') return true;
  return false;
}

/**
 * @param {string[]} files paths, repo-relative, as the GitHub API spells them
 * @returns {{docsOnly: boolean, reasons: string[]}}
 */
export function decideDocsOnly(files) {
  const paths = files.map((f) => f.trim()).filter(Boolean);
  if (paths.length === 0) {
    return {
      docsOnly: false,
      reasons: ['no files in the diff — could not prove this is docs-only, so running everything'],
    };
  }
  const code = paths.filter((p) => !isDocPath(p));
  if (code.length > 0) {
    return {
      docsOnly: false,
      reasons: [
        `${code.length} non-doc file(s) changed`,
        ...code.slice(0, 10).map((p) => `  ${p}`),
        ...(code.length > 10 ? [`  …and ${code.length - 10} more`] : []),
      ],
    };
  }
  return {
    docsOnly: true,
    reasons: [`${paths.length} file(s) changed, all documentation`, ...paths.slice(0, 10).map((p) => `  ${p}`)],
  };
}

// ── CLI ────────────────────────────────────────────────────────────────────

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function readInput() {
  const file = arg('--files');
  if (file) {
    const { readFileSync } = await import('node:fs');
    try {
      return readFileSync(file, 'utf8').split('\n');
    } catch {
      // Unreadable list — fail safe, which decideDocsOnly does for [].
      return [];
    }
  }
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8').split('\n');
}

const isMain = process.argv[1] && process.argv[1].endsWith('decide-docs-only.mjs');
if (isMain) {
  const files = await readInput();
  const { docsOnly, reasons } = decideDocsOnly(files);
  for (const r of reasons) process.stderr.write(`${r}\n`);
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify({ docsOnly, reasons })}\n`);
  } else {
    process.stdout.write(`docs_only=${docsOnly}\n`);
  }
}
