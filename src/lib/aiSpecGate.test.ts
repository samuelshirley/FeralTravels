import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * The gate that keeps the Anthropic-spending E2E specs off every push.
 *
 * `penny-plan-trip` and `chat-maps-link` make real Penny turns. Measured
 * 2026-09-08 across four consecutive CI runs, a full suite made exactly five
 * `/api/trip/replan` calls and cost $0.51–0.58 — and the repo pushes hard
 * enough that 2026-09-03 alone fired 28 CI runs. They now run only when the
 * `ai-tests` label starts the run.
 *
 * Everything here is read as TEXT, deliberately. The three files are a TS
 * config, a plain `.mjs` script and a YAML workflow; nothing can import all
 * three, which is exactly why the list of costly specs is duplicated and why
 * that duplication needs a test. The same reasoning as
 * `decideMobileRelease.test.ts`, which reads `mobile.yml` to prove CI still
 * runs the script it exists to guard.
 *
 * WHAT THIS PROTECTS. Every failure below is silent — a run that looks green
 * and tested less than the reader thinks:
 *   - the two lists drifting, so the assert script waves through a labelled run
 *     in which one costly spec never ran;
 *   - the label plumbing being removed, so the label does nothing and there is
 *     no way to test Penny before merging at all;
 *   - `E2E_MAX_SKIPPED` being raised to "make the gate work", which is how that
 *     allowance stopped meaning anything the last time.
 */
const ROOT = path.resolve(__dirname, '../..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const config = read('playwright.config.ts');
const assertScript = read('scripts/assert-e2e-ran.mjs');
const summaryScript = read('scripts/e2e-pr-summary.mjs');
const ci = read('.github/workflows/ci.yml');

/** Pull a `const NAME = [ ... ]` string-array literal out of source text. */
function stringArray(source: string, name: string): string[] {
  const m = source.match(new RegExp(`${name}\\s*=\\s*\\[([^\\]]*)\\]`));
  if (!m) throw new Error(`${name} not found — the gate has been restructured`);
  return [...m[1].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]);
}

describe('the costly-spec list has exactly one definition in effect', () => {
  it('playwright.config.ts and assert-e2e-ran.mjs name the same specs', () => {
    const fromConfig = stringArray(config, 'AI_SPEC_NAMES');
    const fromAssert = stringArray(assertScript, 'AI_SPEC_NAMES');
    expect(fromConfig.length).toBeGreaterThan(0);
    expect([...fromAssert].sort()).toEqual([...fromConfig].sort());
  });

  it('names the two specs that actually spend, and not the ones that do not', () => {
    const names = stringArray(config, 'AI_SPEC_NAMES');
    expect(names).toContain('penny-plan-trip');
    expect(names).toContain('chat-maps-link');
    // onboarding-flow spends one Sonnet turn at its handoff and is deliberately
    // NOT gated: it is the wizard's only end-to-end coverage and the only proof
    // that `chat_history.form_meta` survives a reload. Decided 2026-09-08 —
    // moving it here is a coverage decision, not a tidy-up.
    expect(names).not.toContain('onboarding-flow');
    expect(stringArray(config, 'WEB_UI_SPEC_NAMES')).toContain('onboarding-flow');
  });

  it('the web-ui project no longer hardcodes the spec list it is built from', () => {
    expect(config).toContain('testMatch: webUiTestMatch');
    // The old literal regex listed every spec inline; a reinstated one would
    // run the costly specs on every push again while every check here passed.
    expect(config).not.toMatch(/testMatch:\s*\/\(existing-trip\|/);
  });
});

describe('the label plumbing in ci.yml', () => {
  it('CI still fires on `labeled`, or the label can never run anything', () => {
    expect(ci).toMatch(/types:\s*\[opened, synchronize, reopened, ready_for_review, labeled\]/);
  });

  it('the E2E job turns the `ai-tests` label into E2E_AI_SPECS', () => {
    expect(ci).toContain('E2E_AI_SPECS=1');
    expect(ci).toContain('E2E_AI_SPECS=0');
    expect(ci).toMatch(/LABEL_NAME"?\s*=\s*"ai-tests"/);
  });

  it('reads the label through env, never interpolated into the shell', () => {
    // A label is attacker-controllable text on a public repo. `${{ }}` inside a
    // `run:` block is a command-injection hole, so the value must arrive as an
    // environment variable and be quoted.
    expect(ci).toContain('LABEL_NAME: ${{ github.event.label.name }}');
    expect(ci).not.toMatch(/=\s*"\$\{\{\s*github\.event\.label\.name/);
  });

  it('gates on the run STARTING from the label, not on the PR carrying it', () => {
    // `contains(pull_request.labels.*.name, ...)` would put the costly specs
    // back on every push made while the label sat on the PR — the exact thing
    // being switched off.
    expect(ci).toMatch(/EVENT_ACTION"?\s*=\s*"labeled"/);
    expect(ci).not.toContain("contains(github.event.pull_request.labels.*.name, 'ai-tests')");
  });

  it('the skip allowance was NOT loosened to accommodate the gate', () => {
    // Gated specs are dropped from testMatch and produce no result at all, so
    // they cannot inflate the skip count. If this is ever above 0 again, the
    // question to answer first is what started skipping.
    expect(ci).toMatch(/E2E_MAX_SKIPPED:\s*'0'/);
  });

  it('the runner-side gate uses the CI key, never the production one', () => {
    // The value is only tested for presence, but a production key on a public
    // repo's runner is a production key one bad log line from being public.
    expect(ci).toContain('ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY_CI }}');
    expect(ci).not.toContain('ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}');
  });
});

describe('a run that did not exercise Penny says so', () => {
  it('assert-e2e-ran.mjs fails a labelled run in which a costly spec produced nothing', () => {
    expect(assertScript).toContain('AI_SPECS_REQUESTED');
    expect(assertScript).toMatch(/if \(AI_SPECS_REQUESTED\)/);
    expect(assertScript).toContain('process.exit(1)');
  });

  it('the PR comment distinguishes the two kinds of green', () => {
    // Without this the reader cannot tell, at the moment they are deciding to
    // merge, whether Penny was asked to plan anything.
    expect(summaryScript).toContain("process.env.E2E_AI_SPECS === '1'");
    expect(summaryScript).toContain('ai-tests');
  });
});
