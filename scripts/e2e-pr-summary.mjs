#!/usr/bin/env node
/**
 * Turn Playwright's JSON report into a markdown summary for a PR comment.
 *
 * The HTML report is a directory of files, so it can't live in a comment. CI
 * publishes it to Vercel and this links it — one click to traces, screenshots,
 * video and every assertion. The artifact stays as a fallback for when
 * publishing fails.
 *
 * NOTE for whoever reads this later: that report URL is PUBLIC and unguessable
 * only by obscurity, and it renders whatever the app showed during the run —
 * i.e. the contents of a preview backed by a clone of the production database.
 * That is fine today because the app's data is Sam's own. If FeralTravels ever
 * has real users, this link is a data leak and should go back to being an
 * artifact behind repo auth.
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
      /**
       * ONE ROW PER TEST, not per spec.
       *
       * `spec.tests` holds one entry per PROJECT, and this used to read
       * `spec.tests[0]` — so a spec that passes in `api` and fails in
       * `web-blocked` reported the pass and hid the failure. `spec.ok` is
       * likewise the whole spec's verdict, so pairing it with one project's
       * status could label a failing row green.
       *
       * That is not hypothetical: the run that prompted this rewrite posted
       * "✅ 78 passed" on a job that exited 1. The stale-JSON half of that is
       * fixed in ci.yml; this is the half that would have gone on lying every
       * time a spec ran in more than one project.
       */
      for (const t of spec.tests ?? []) {
        const result = t.results?.[t.results.length - 1];
        const status = t.status ?? result?.status ?? 'unknown';
        rows.push({
          file: (spec.file || f || '').replace(/^e2e\//, ''),
          project: t.projectName || '',
          title: [suite.title && suite.title !== f ? suite.title : '', spec.title]
            .filter(Boolean)
            .join(' › '),
          status,
          // The TEST's own verdict. 'expected' is a pass; anything else is not.
          ok: status === 'expected',
          ms: result?.duration ?? 0,
        });
      }
    }
    walk(suite.suites, f);
  }
};
walk(report.suites);

const multiProject = new Set(rows.map((r) => r.project)).size > 1;

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
  // The project is only shown when it disambiguates — the same spec run against
  // two deployments is otherwise two identical-looking rows.
  const proj = r.project && multiProject ? ` <sub>[${r.project}]</sub>` : '';
  out.push(`| ${icon(r)} | ${where}${r.title}${proj} | ${r.status === 'skipped' ? '—' : secs(r.ms)} |`);
}
out.push('');

const reportUrl = process.env.REPORT_URL;
const artifact = process.env.ARTIFACT_URL;

if (reportUrl) {
  out.push(`## [▶ Open the Playwright report](${reportUrl})`);
  out.push('');
  out.push('Every step of every spec, with screenshots, video and the trace viewer. No download.');
  if (artifact) out.push(`<sub>Also available as a <a href="${artifact}">downloadable artifact</a>.</sub>`);
} else if (artifact) {
  out.push(
    `**[⬇︎ Download the report](${artifact})** — publishing the hosted version failed (see the` +
      ' "Publish the HTML report" step). Unzip and open `playwright-report/index.html`.'
  );
}
out.push('');

process.stdout.write(out.join('\n') + '\n');
