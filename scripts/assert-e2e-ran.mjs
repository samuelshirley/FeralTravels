#!/usr/bin/env node
/**
 * Fail CI when the E2E suite reported green without actually testing anything.
 *
 * Every authenticated spec signs in through a real OTP email via MailSlurp, and
 * e2e/fixtures/auth.ts deliberately SKIPS (rather than fails) when MailSlurp is
 * unavailable — a third-party outage shouldn't red the pipeline. The cost of
 * that choice is that quota exhaustion produces a run where nearly every spec
 * skipped and Playwright still exits 0.
 *
 * That was survivable when promoting to production was a manual button. It is
 * not survivable now that a green PR auto-ships on merge: "green" has to mean
 * "the app was exercised". So this asserts, from Playwright's JSON report:
 *
 *   - at least one test actually ran, and
 *   - no more than E2E_MAX_SKIPPED tests were skipped (default 1).
 *
 * A legitimate new skip (a spec you've deliberately parked) means bumping
 * E2E_MAX_SKIPPED in the workflow — deliberately, in a diff, with a reason.
 */

import { readFileSync, existsSync } from 'node:fs';
import { appendFileSync } from 'node:fs';

const REPORT = process.env.PLAYWRIGHT_JSON_REPORT || 'playwright-results.json';
const MAX_SKIPPED = Number(process.env.E2E_MAX_SKIPPED ?? 1);

function summary(line) {
  process.stdout.write(`${line}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    try {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
    } catch {
      /* summary is best-effort */
    }
  }
}

if (!existsSync(REPORT)) {
  summary(`::error::No Playwright JSON report at ${REPORT} — the suite did not run to completion.`);
  process.exit(1);
}

const report = JSON.parse(readFileSync(REPORT, 'utf8'));

// Playwright's top-level stats when present; otherwise walk the suite tree and
// count test statuses ourselves (keeps this working across reporter versions).
let { expected = 0, unexpected = 0, flaky = 0, skipped = 0 } = report.stats ?? {};
if (!report.stats) {
  const walk = (suites = []) => {
    for (const suite of suites) {
      for (const spec of suite.specs ?? []) {
        for (const t of spec.tests ?? []) {
          const status = t.status ?? t.results?.[0]?.status;
          if (status === 'skipped') skipped++;
          else if (status === 'expected' || status === 'passed') expected++;
          else if (status === 'flaky') flaky++;
          else unexpected++;
        }
      }
      walk(suite.suites);
    }
  };
  walk(report.suites);
}

const ran = expected + unexpected + flaky;
summary(
  `### E2E coverage check\n\n- ran: **${ran}** (passed ${expected}, failed ${unexpected}, flaky ${flaky})\n- skipped: **${skipped}** (max allowed ${MAX_SKIPPED})`,
);

if (ran === 0) {
  summary(
    '::error::Every E2E test skipped — nothing was verified. Almost always MAILSLURP_API_KEY missing, or the MailSlurp free-tier quota exhausted/auto-disabled. Fix that before merging; a green check here would otherwise auto-ship to production.',
  );
  process.exit(1);
}

if (skipped > MAX_SKIPPED) {
  summary(
    `::error::${skipped} E2E tests skipped (max ${MAX_SKIPPED}). Check the MailSlurp quota — mass-skips make CI green while testing nothing. If the skips are intentional, raise E2E_MAX_SKIPPED in .github/workflows/ci.yml.`,
  );
  process.exit(1);
}

summary('E2E suite genuinely ran. ✅');
