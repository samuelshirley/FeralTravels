import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * The gate that keeps the Anthropic-spending e2e flows off every push.
 *
 * Measured 2026-09-08 across four consecutive CI runs, a full suite's Penny
 * turns cost $0.51–0.58 — and the repo pushes hard enough that 2026-09-03 alone
 * fired 28 CI runs. So the flows that ask Penny to plan for real run only when
 * the `ai-tests` label starts the run.
 *
 * WHERE THEY LIVE (2026-09-27): the iOS Maestro shard `ai`
 * (mobile/maestro/shards/ai.yaml) — penny-plan-trip.yaml and
 * penny-maps-link.yaml, the most thorough flows in the suite on purpose (Sam:
 * the expensive ones are how a driver really uses the app). penny-jev-gate.yaml
 * joined them 2026-10-02: it spends Penny turns AND is the one flow that
 * calls Jev, so it must never run on a push. The first two were
 * Playwright specs until 2026-09-27, gated by `E2E_AI_SPECS` in the E2E job; the
 * decide job now drops the `ai` shard from the iOS matrix unless the label
 * started the run.
 *
 * Everything here is read as TEXT, deliberately: a YAML workflow, a Maestro
 * shard config and a TS config cannot import each other.
 *
 * WHAT THIS PROTECTS. Every failure below is silent — a run that looks green
 * and tested less than the reader thinks, or spent more than it should:
 *   - the spending flows leaking into a shard that runs on every push;
 *   - the label plumbing being removed, so there is no way to test Penny
 *     before merging at all;
 *   - the gate keying on the PR CARRYING the label, which spends on every push;
 *   - `E2E_MAX_SKIPPED` being raised, which is how that allowance stopped
 *     meaning anything the last time.
 */
const ROOT = path.resolve(__dirname, '../..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const ci = read('.github/workflows/ci.yml');
const config = read('playwright.config.ts');
const SHARD_DIR = 'mobile/maestro/shards';

/** The `flows:` list of one shard config. */
function shardFlows(name: string): string[] {
  const source = read(`${SHARD_DIR}/${name}.yaml`);
  const block = source.match(/^flows:\s*\n((?:\s+- .*\n?)+)/m);
  if (!block) throw new Error(`${name}.yaml has no flows: list — the shard format changed`);
  return [...block[1].matchAll(/-\s+([\w.-]+)/g)].map((m) => m[1]);
}

const SPENDING_FLOWS = ['penny-plan-trip.yaml', 'penny-maps-link.yaml', 'penny-jev-gate.yaml'];

describe('the spending flows are in the `ai` shard and nowhere else', () => {
  it('the `ai` shard is exactly the flows that ask Penny to plan', () => {
    expect([...shardFlows('ai')].sort()).toEqual([...SPENDING_FLOWS].sort());
  });

  it('no shard that runs on every push carries one of them', () => {
    const everyPush = fs
      .readdirSync(path.join(ROOT, SHARD_DIR))
      .filter((f) => f.endsWith('.yaml') && f !== 'ai.yaml')
      .map((f) => f.slice(0, -'.yaml'.length));
    expect(everyPush.length).toBeGreaterThan(0);
    for (const shard of everyPush) {
      for (const flow of SPENDING_FLOWS) {
        expect(shardFlows(shard), `${flow} would spend on every push from shard ${shard}`).not.toContain(flow);
      }
    }
  });

  it('the onboarding hand-off stays OUTSIDE the gate, on purpose', () => {
    // onboarding-wizard spends one Penny turn at its hand-off and is
    // deliberately NOT gated: it is the wizard's only end-to-end coverage and
    // the only proof the answers survive a relaunch. Decided 2026-09-08 for the
    // web spec it replaced — moving it into `ai` is a coverage decision, not a
    // tidy-up.
    expect(shardFlows('ai')).not.toContain('onboarding-wizard.yaml');
    expect(shardFlows('account')).toContain('onboarding-wizard.yaml');
  });

  it('the Playwright suite asks Penny nothing, so it has no gate of its own to drift', () => {
    expect(config).not.toContain('AI_SPEC_NAMES');
    expect(fs.existsSync(path.join(ROOT, 'e2e/penny-plan-trip.spec.ts'))).toBe(false);
    expect(fs.existsSync(path.join(ROOT, 'e2e/chat-maps-link.spec.ts'))).toBe(false);
  });
});

describe('the label plumbing in ci.yml', () => {
  it('CI still fires on `labeled`, or the label can never run anything', () => {
    expect(ci).toMatch(/types:\s*\[opened, synchronize, reopened, ready_for_review, labeled\]/);
  });

  it('the decide job adds the `ai` shard only for the `ai-tests` label', () => {
    expect(ci).toMatch(/LABEL_NAME"?\s*=\s*"ai-tests"/);
    expect(ci).toContain("n !== 'ai' || process.env.IOS_AI === '1'");
    expect(ci).toContain('ios_shards: ${{ steps.shards.outputs.ios_shards }}');
    expect(ci).toContain('shard: ${{ fromJSON(needs.decide.outputs.ios_shards) }}');
  });

  it('reads the label through env, never interpolated into the shell', () => {
    // A label is attacker-controllable text on a public repo. `${{ }}` inside a
    // `run:` block is a command-injection hole, so the value must arrive as an
    // environment variable and be quoted.
    expect(ci).toContain('LABEL_NAME: ${{ github.event.label.name }}');
    expect(ci).not.toMatch(/=\s*"\$\{\{\s*github\.event\.label\.name/);
  });

  it('gates on the run STARTING from the label, not on the PR carrying it', () => {
    // `contains(pull_request.labels.*.name, ...)` would put the spend back on
    // every push made while the label sat on the PR — the exact thing being
    // switched off.
    expect(ci).toMatch(/EVENT_ACTION"?\s*=\s*"labeled"/);
    expect(ci).not.toContain("contains(github.event.pull_request.labels.*.name, 'ai-tests')");
  });

  it('the skip allowance was NOT loosened', () => {
    expect(ci).toMatch(/E2E_MAX_SKIPPED:\s*'0'/);
  });

  it('no Anthropic key sits on a runner: nothing on the runner calls Penny', () => {
    // The Penny flows call her through the PREVIEW, which bills the CI key
    // from the Vercel preview environment (anthropicKey.ts). The runner-side
    // copy existed only for the Playwright specs' presence check; a key on a
    // public repo's runner is a key one bad log line from being public.
    expect(ci).not.toMatch(/ANTHROPIC_API_KEY:\s*\$\{\{ secrets\./);
  });
});

describe('a run that did not exercise Penny says so', () => {
  it('the iOS PR comment distinguishes the two kinds of green', () => {
    // Without this the reader cannot tell, at the moment they are deciding to
    // merge, whether Penny was asked to plan anything.
    expect(ci).toContain("if (!expected.includes('ai'))");
    expect(ci).toContain('did not run — add the `ai-tests` label to run them.');
  });

  it('a labelled run whose `ai` shard produced nothing is red, not green', () => {
    // Every expected shard must report success; one that never ran reads as
    // "did not run" and fails the summary.
    expect(ci).toContain("const outcome = r?.outcome || 'did not run';");
    expect(ci).toMatch(/RESULT: \$\{\{ needs\.ios-e2e\.result \}\}[\s\S]*\[ "\$RESULT" = "success" \]/);
  });
});
