#!/usr/bin/env node
/**
 * Turn Playwright's JSON report into a markdown summary for a PR comment.
 *
 * The HTML report is a directory of files, so it can't live in a comment —
 * and it deliberately does NOT get published to a public URL: its screenshots,
 * videos and traces are of a preview backed by a CLONE OF PRODUCTION DATA
 * (real users, real trips, real GPS). It ships as a build artifact, which is
 * behind repo auth. What goes in the comment is the per-spec result table plus
 * the artifact link.
 *
 * Writes markdown to stdout. Reads playwright-results.json (the `json`
 * reporter configured in playwright.config.ts).
 */
import { readFileSync, existsSync } from 'node:fs';

const REPORT = process.env.PLAYWRIGHT_JSON_REPORT || 'playwright-results.json';

if (!existsSync(REPORT)) {
  process.stdout.write(
    '### 🎭 E2E results\n\nNo Playwright report was produced — the suite did not run to completion. See the job log.\n'
  );
  process.exit(0);
}

const report = JSON.parse(readFileSync(REPORT, 'utf8'));

/** Flatten the suite tree into one row per spec. */
const rows = [];
const walk = (suites = [], file = '') => {
  for (const suite of suites) {
    const f = suite.file || file;
    for (const spec of suite.specs ?? []) {
      const result = spec.tests?.[0]?.results?.[0];
      const status = spec.tests?.[0]?.status ?? result?.status ?? 'unknown';
      rows.push({
        file: (spec.file || f || '').replace(/^e2e\//, ''),
        title: [suite.title && suite.title !== f ? suite.title : '', spec.title]
          .filter(Boolean)
          .join(' › '),
        status,
        ok: spec.ok === true && status !== 'skipped',
        ms: result?.duration ?? 0,
      });
    }
    walk(suite.suites, f);
  }
};
walk(report.suites);

const icon = (r) =>
  r.status === 'skipped' ? '⏭️' : r.ok ? '✅' : r.status === 'flaky' ? '⚠️' : '❌';
const secs = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`);

const s = report.stats ?? {};
const passed = s.expected ?? rows.filter((r) => r.ok).length;
const failed = s.unexpected ?? rows.filter((r) => !r.ok && r.status !== 'skipped').length;
const skipped = s.skipped ?? rows.filter((r) => r.status === 'skipped').length;
const flaky = s.flaky ?? 0;

const headline = failed > 0 ? '❌' : skipped > 0 ? '⚠️' : '✅';
const parts = [`${passed} passed`];
if (failed) parts.push(`**${failed} failed**`);
if (flaky) parts.push(`${flaky} flaky`);
if (skipped) parts.push(`${skipped} skipped`);

const out = [];
out.push(`### ${headline} E2E results — ${parts.join(', ')}`);
out.push('');

// Failures first — that's what you came to read.
const ordered = [...rows].sort((a, b) => Number(a.ok) - Number(b.ok));
out.push('| | Spec | |');
out.push('|---|---|---|');
for (const r of ordered) {
  const where = r.file ? `\`${r.file}\` ` : '';
  out.push(`| ${icon(r)} | ${where}${r.title} | ${r.status === 'skipped' ? '—' : secs(r.ms)} |`);
}
out.push('');

const artifact = process.env.ARTIFACT_URL;
if (artifact) {
  out.push(
    `**[⬇︎ Full HTML report](${artifact})** — download, unzip, open \`playwright-report/index.html\`` +
      ' for the trace, screenshots and video of every step of every spec.'
  );
  out.push('');
  out.push(
    '<sub>Not published to a URL on purpose: the report shows a preview backed by a clone of the' +
      ' production database, so its screenshots contain real user data. The artifact is behind repo auth.</sub>'
  );
}

process.stdout.write(out.join('\n') + '\n');
