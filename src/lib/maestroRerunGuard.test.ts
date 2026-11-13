import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  HARNESS_SIGNATURES,
  failedFlows,
  flowLogs,
  planRerun,
  rerunConfig,
  shardFlows,
} from '../../scripts/maestro-rerun.mjs';

/**
 * An iOS shard re-runs its failed flows ONCE, and only for a simulator
 * failure — never for the app.
 *
 * Between 2026-11-04 and 11-13 five shard jobs went red on two harness
 * failures: the app launch racing its own reinstall ("unknown to FrontBoard"),
 * which the `retry:` in sign-in.yaml cannot catch because Maestro's retry only
 * catches MaestroException, and the XCTest driver dying mid-shard. Each cost a
 * full re-run of the whole CI run. scripts/maestro-rerun.mjs has the story.
 *
 * The ways this quietly goes wrong: the re-run widens into a blanket retry
 * (a regression becomes "flaky"), the signatures drift from what Maestro
 * actually prints (the re-run silently never fires, like 4f23a18's), or a
 * re-run overspends the runner's sign-in codes and fails in a way that looks
 * like a flake. Each has a check below.
 */

const ROOT = path.join(__dirname, '..', '..');
const ci = readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');

/** Lines copied verbatim from the failing CI logs (timestamps dropped). */
const FRONTBOARD_LINE =
  'The request was denied by service delegate (SBMainWorkspace) for reason: NotFound ("Application "com.feraltravels.ios" is unknown to FrontBoard").';
const DRIVER_DEATH_LINES = [
  // The JUnit report's own <failure> text, which the script also reads.
  '<failure>maestro.DeviceUnreachableException: Device became unreachable during isScreenStatic</failure>',
  'Caused by: ios.IOSDeviceErrors$Unreachable: Device became unreachable while processing isScreenStatic',
  'Caused by: maestro.utils.network.XCUITestServerError$Unreachable: Transport unreachable while processing isScreenStatic',
];
const APP_FAILURE_LINE = 'Assertion is false: id: settings-location-section is not visible';

function junit(shard: string, failed: string[]): string {
  const cases = shardFlows(shard).map((f: string) => {
    const name = f.replace(/\.yaml$/, '');
    const status = failed.includes(f) ? 'ERROR' : 'SUCCESS';
    return `    <testcase id="${name}" name="${name}" classname="${name}" file="mobile/maestro/${f}" time="1" status="${status}"/>`;
  });
  return `<testsuites>\n  <testsuite name="Test Suite" tests="${cases.length}">\n${cases.join('\n')}\n  </testsuite>\n</testsuites>`;
}

describe('the re-run fires on a simulator failure, and only then', () => {
  it('FrontBoard: re-runs exactly the failed flows, in shard order', () => {
    // Run 43449367820 attempt 2, `core`, as it failed.
    const failed = ['settings-location.yaml', 'chat-tab-in-flight.yaml'];
    const plan = planRerun({ shard: 'core.yaml', junit: junit('core.yaml', failed), log: `...\n${FRONTBOARD_LINE}\n...` });
    expect(plan).toEqual({
      rerun: true,
      reason: expect.stringContaining('FrontBoard'),
      flows: ['chat-tab-in-flight.yaml', 'settings-location.yaml'],
    });
  });

  it('driver death: either line Maestro prints is enough', () => {
    for (const line of DRIVER_DEATH_LINES) {
      const plan = planRerun({ shard: 'core.yaml', junit: junit('core.yaml', ['chat-keyboard.yaml']), log: line });
      expect(plan.rerun, line).toBe(true);
    }
  });

  it('an app failure on its own is never re-run', () => {
    const plan = planRerun({ shard: 'core.yaml', junit: junit('core.yaml', ['settings-location.yaml']), log: APP_FAILURE_LINE });
    expect(plan.rerun).toBe(false);
  });

  it('the launch-retry signature is not one of them — that retry is launch.yaml\'s own', () => {
    const plan = planRerun({ shard: 'core.yaml', junit: junit('core.yaml', ['chat-keyboard.yaml']), log: 'iOS driver not ready in time' });
    expect(plan.rerun).toBe(false);
  });

  it('a report that names no failed flow re-runs nothing', () => {
    const plan = planRerun({ shard: 'core.yaml', junit: junit('core.yaml', []), log: FRONTBOARD_LINE });
    expect(plan.rerun).toBe(false);
  });

  it('every signature matches a line Maestro really printed', () => {
    const real = [FRONTBOARD_LINE, ...DRIVER_DEATH_LINES];
    for (const s of HARNESS_SIGNATURES) {
      expect(real.some((l) => s.pattern.test(l)), s.reason).toBe(true);
      expect(s.pattern.test(APP_FAILURE_LINE), s.reason).toBe(false);
    }
  });
});

describe('the evidence is the FAILED flows\' own logs, not the console', () => {
  // Maestro's console says "[Failed] chat-tab-in-flight (51s) (Unknown
  // error)"; the FrontBoard line exists only in that flow's maestro.log
  // (run 43449367820). Reading the console, the re-run would never fire.
  const root = mkdtempSync(path.join(tmpdir(), 'maestro-debug-'));
  const log = (flow: string, text: string) => {
    const dir = path.join(root, '.maestro', 'tests', '2026-11-13_154525', flow, 'logs');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'maestro.log'), text);
  };
  log('chat-tab-in-flight', `launching\n${FRONTBOARD_LINE}\n`);
  log('chat-keyboard', 'all fine\n');

  it('finds the line under the dot-directory Maestro writes', () => {
    expect(flowLogs(root, ['chat-tab-in-flight.yaml'])).toContain('unknown to FrontBoard');
  });

  it('ignores a passing flow\'s log', () => {
    expect(flowLogs(root, ['chat-keyboard.yaml'])).not.toContain('FrontBoard');
  });

  it('the command CI runs reads them: a FrontBoard line only in the flow log is enough', () => {
    const junitPath = path.join(root, 'report.xml');
    writeFileSync(junitPath, junit('core.yaml', ['chat-tab-in-flight.yaml']));
    const out = path.join(root, 'rerun.yaml');
    const r = spawnSync('node', ['scripts/maestro-rerun.mjs', 'core', junitPath, root, out], { cwd: ROOT, encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^flows=chat-tab-in-flight\.yaml$/m);
    expect(readFileSync(out, 'utf8')).toMatch(/flowsOrder:\n {4}- chat-tab-in-flight\n/);
  });

  it('…and says no, exit 1, when the only failure is the app', () => {
    const junitPath = path.join(root, 'report-app.xml');
    writeFileSync(junitPath, junit('core.yaml', ['chat-keyboard.yaml']));
    const r = spawnSync('node', ['scripts/maestro-rerun.mjs', 'core', junitPath, root, path.join(root, 'x.yaml')], { cwd: ROOT, encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/^No re-run: /);
  });

  it('a missing debug directory is no evidence, not a crash', () => {
    expect(flowLogs(path.join(root, 'nope'), ['chat-keyboard.yaml'])).toBe('');
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));
});

describe('a re-run never overspends the runner\'s sign-in codes', () => {
  it('refuses when the failed flows would push the runner past its hourly limit', () => {
    // Nov 7 `flows`: the driver died and took every later flow with it.
    const all = shardFlows('flows.yaml');
    const plan = planRerun({ shard: 'flows.yaml', junit: junit('flows.yaml', all), log: DRIVER_DEATH_LINES[0] });
    expect(plan.rerun).toBe(false);
    expect(plan.why).toMatch(/sign-in codes/);
  });

  it('allows the common case, one or two flows', () => {
    for (const shard of ['account.yaml', 'ai.yaml', 'core.yaml', 'flows.yaml', 'settings.yaml', 'trips.yaml']) {
      const first = shardFlows(shard).slice(-1);
      const plan = planRerun({ shard, junit: junit(shard, first), log: FRONTBOARD_LINE });
      expect(plan.rerun, shard).toBe(true);
    }
  });
});

describe('the re-run config is a shard file Maestro reads the same way', () => {
  it('names the same flows under flows: and flowsOrder, and keeps going past a failure', () => {
    const yaml = rerunConfig(['chat-tab-in-flight.yaml', 'settings-location.yaml']);
    expect(yaml).toMatch(/^flows:\n {2}- chat-tab-in-flight\.yaml\n {2}- settings-location\.yaml\n/m);
    expect(yaml).toMatch(/flowsOrder:\n {4}- chat-tab-in-flight\n {4}- settings-location\n/);
    expect(yaml).toMatch(/continueOnFailure: true/);
  });

  it('failedFlows reads Maestro\'s JUnit, ERROR and anything else not SUCCESS', () => {
    const xml = junit('core.yaml', ['chat-keyboard.yaml']).replace('status="ERROR"', 'status="FAILURE"');
    expect(failedFlows(xml)).toEqual(['chat-keyboard.yaml']);
  });
});

describe('ci.yml runs it once, and says so', () => {
  const step = ci.slice(ci.indexOf('- name: Run the flows'), ci.indexOf('- name: Say where the flow died'));

  it('the shard step asks the script, and re-runs at most once', () => {
    // The debug output, not the console log: the console never prints the
    // FrontBoard line (it is only in the flow's maestro.log).
    expect(step).toMatch(/node scripts\/maestro-rerun\.mjs "\$SHARD" "maestro-report-\$SHARD\.xml" maestro-debug "\$RERUN_CONFIG"/);
    // Exactly two run_flows calls: the shard, and the one re-run. A loop or a
    // third call is a blanket retry.
    expect([...step.matchAll(/\brun_flows "/g)]).toHaveLength(2);
    expect(step).not.toMatch(/for attempt in [^\n]*\n[^\n]*run_flows/);
    // The re-run writes its own report, so the first one keeps its failures.
    expect(step).toMatch(/run_flows "\$RERUN_CONFIG" "maestro-report-\$SHARD-rerun\.xml"/);
  });

  it('the re-run is recorded and lands in the PR comment', () => {
    expect(step).toMatch(/echo "harness_rerun=\$REASON: \$FLOWS" >> "\$GITHUB_OUTPUT"/);
    expect(ci).toMatch(/HARNESS_RERUN: \$\{\{ steps\.flows\.outputs\.harness_rerun \}\}/);
    expect(ci).toMatch(/harnessRerun:process\.env\.HARNESS_RERUN/);
    expect(ci).toMatch(/Re-ran failed flows once/);
  });
});
