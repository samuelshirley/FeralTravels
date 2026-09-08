#!/usr/bin/env node
/**
 * Fail CI when the E2E suite reported green without actually testing anything.
 *
 * Specs SKIP (rather than fail) when something they need isn't configured — a
 * real mailbox for login-otp, an Anthropic key for the Penny spec. That's the
 * right behaviour for a fresh checkout and the wrong behaviour for CI, where a
 * run in which nearly every spec skipped still exits 0.
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

/**
 * The Anthropic-spending specs, which playwright.config.ts drops from
 * `testMatch` unless E2E_AI_SPECS=1 (the `ai-tests` label). Duplicated here
 * rather than imported because this file is plain .mjs and the config is TS;
 * `src/lib/aiSpecGateGuard.test.ts` fails the unit suite if the two lists ever
 * disagree.
 *
 * The asymmetry below is the whole point. When they are gated OFF we say so
 * loudly, because a green check that never asked Penny to plan anything must
 * not read like one that did. When they are gated ON we FAIL if they produced
 * no result — otherwise a typo in the label, the regex or the env plumbing
 * would look identical to a passing run, which is the same "green but empty"
 * shape this script was written to catch in the first place.
 */
const AI_SPEC_NAMES = ['penny-plan-trip', 'chat-maps-link'];
const AI_SPECS_REQUESTED = process.env.E2E_AI_SPECS === '1';

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

// Playwright's `list` reporter prints WHICH tests skipped but never WHY, which
// turns a mass-skip into a dashboard archaeology session. The JSON report keeps
// the reason on each test's annotations — surface it.
const reasons = new Map();
const collectReasons = (suites = []) => {
  for (const suite of suites) {
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests ?? []) {
        const status = t.status ?? t.results?.[0]?.status;
        if (status !== 'skipped') continue;
        for (const a of t.annotations ?? spec.annotations ?? []) {
          if (a?.type !== 'skip' && a?.type !== 'fixme') continue;
          const why = (a.description || '(no reason given)').trim();
          reasons.set(why, (reasons.get(why) ?? 0) + 1);
        }
      }
    }
    collectReasons(suite.suites);
  }
};
try {
  collectReasons(report.suites);
} catch {
  /* reason extraction is best-effort — never fail the build over it */
}

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

if (reasons.size) {
  summary('\nSkip reasons:');
  for (const [why, count] of [...reasons].sort((a, b) => b[1] - a[1])) {
    summary(`- ${count}x — ${why}`);
  }
}

// Tolerated skips are still missing coverage. Say so on EVERY run, so a raised
// allowance can't quietly become the permanent state of the pipeline.
if (skipped > 0 && skipped <= MAX_SKIPPED) {
  summary(
    `::warning::${skipped} of ${skipped + ran} E2E tests did not run. This build is green on ${ran} test(s). The skip allowance (E2E_MAX_SKIPPED=${MAX_SKIPPED}) is a temporary concession in .github/workflows/pipeline.yml — lower it back to 1 once e2e sign-in works.`,
  );
}

// Which spec FILES produced at least one non-skipped result. Walked from the
// suite tree rather than report.stats, which counts but does not name.
const filesThatRan = new Set();
const collectFiles = (suites = [], file = '') => {
  for (const suite of suites) {
    const here = suite.file || file;
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests ?? []) {
        const status = t.status ?? t.results?.[0]?.status;
        if (status !== 'skipped') filesThatRan.add(here);
      }
    }
    collectFiles(suite.suites, here);
  }
};
try {
  collectFiles(report.suites);
} catch {
  /* best-effort — the assertions below fall through to the generic checks */
}

const aiSpecsThatRan = AI_SPEC_NAMES.filter((name) =>
  [...filesThatRan].some((f) => f.includes(name))
);

if (AI_SPECS_REQUESTED) {
  const missing = AI_SPEC_NAMES.filter((n) => !aiSpecsThatRan.includes(n));
  if (missing.length) {
    summary(
      `::error::E2E_AI_SPECS=1 asked for the Anthropic-spending specs, but ${missing
        .map((n) => `${n}.spec.ts`)
        .join(' and ')} produced no result. The label ran the pipeline without ` +
        'running what the label is FOR — check E2E_AI_SPECS reached the Playwright ' +
        'step and that the names still match AI_SPEC_NAMES in playwright.config.ts.',
    );
    process.exit(1);
  }
  summary(`\nAnthropic-spending specs ran: ${aiSpecsThatRan.join(', ')}. 💸`);
} else {
  summary(
    `::warning::Penny was not asked to plan anything on this run. ${AI_SPEC_NAMES.map(
      (n) => `${n}.spec.ts`,
    ).join(' and ')} are gated behind the \`ai-tests\` label to keep the Anthropic ` +
      'bill off every push — add that label to the PR before merging, and the ' +
      'run it triggers is the one to merge on.',
  );
}

if (ran === 0) {
  summary(
    '::error::Every E2E test skipped — nothing was verified. Almost always E2E_TEST_ENDPOINTS=1 missing on the target, or the x-e2e-test-secret header not matching. Fix that before merging; a green check here would otherwise auto-ship to production.',
  );
  process.exit(1);
}

if (skipped > MAX_SKIPPED) {
  summary(
    `::error::${skipped} E2E tests skipped (max ${MAX_SKIPPED}). Mass-skips make CI green while testing nothing — check the mailbox preflight output above. If the skips are intentional, raise E2E_MAX_SKIPPED in .github/workflows/pipeline.yml.`,
  );
  process.exit(1);
}

summary(
  skipped > 0
    ? `Passed the coverage check on ${ran} test(s), with ${skipped} skipped under the current allowance. ⚠️`
    : 'E2E suite genuinely ran. ✅',
);
