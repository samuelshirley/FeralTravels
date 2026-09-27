import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * Every `${VAR}` a Maestro flow references must be supplied by every runner
 * that runs that flow.
 *
 * This exists because the same mistake has now been made twice, and both times
 * it passed locally and failed only on CI — the most expensive shape of bug
 * this repo has.
 *
 * The second one: `sign-in.yaml` asserted on the literal `E2E Fixture Trip`
 * until `ios-e2e-local.sh screenshots` needed the same seeded graph under a
 * customer-readable name, at which point it became `.*${TRIP_NAME}.*`. The
 * local runner was taught to pass it. `ci.yml` was not. So on CI the variable
 * was never defined, the assertion could not match a card reading "E2E Fixture
 * Trip", and the failure surfaced as `step-025-assertCondition-${TRIP_NAME}` —
 * two layers away from the edit that caused it, in a 27-minute macOS job.
 *
 * Nothing else could have caught it. Maestro does not fail on an undefined
 * variable, it just fails to match. `tsc` cannot see inside a YAML file. And
 * the flows are only executed by a job that costs ~10x a Linux runner, so
 * "run it and see" is not the feedback loop.
 *
 * Read as TEXT, never imported — same reason as `privacyManifest.test.ts` and
 * `routeLabels.test.ts`: `noMobileImportGuard.test.ts` forbids `src/` importing
 * from `mobile/`, because CI's unit job installs no `mobile/node_modules`.
 */
const ROOT = path.resolve(__dirname, '../..');
const FLOW_DIR = path.join(ROOT, 'mobile/maestro');
const CI = fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');
const LOCAL = fs.readFileSync(path.join(ROOT, 'scripts/ios-e2e-local.sh'), 'utf8');

/** The flows CI actually invokes, and the flow each one pulls in. */
const SHARD_DIR = path.join(FLOW_DIR, 'shards');

/**
 * The shard configs are the list of what CI runs: ci.yml runs `launch.yaml`
 * on every shard, then `maestro test mobile/maestro --config shards/<name>.yaml`.
 * Read with two small regexes rather than a YAML dependency — the format is
 * fixed and a test below fails if a config stops matching it.
 */
function listUnder(source: string, key: string): string[] {
  const block = source.match(new RegExp(`^\\s*${key}:\\s*\\n((?:\\s+- .*\\n?)+)`, 'm'));
  return block ? [...block[1].matchAll(/-\s+([\w.-]+)/g)].map((m) => m[1]) : [];
}

const SHARDS = fs
  .readdirSync(SHARD_DIR)
  .filter((f) => f.endsWith('.yaml'))
  .map((f) => {
    const source = live(fs.readFileSync(path.join(SHARD_DIR, f), 'utf8'));
    return {
      name: f.slice(0, -'.yaml'.length),
      flows: listUnder(source, 'flows'),
      order: listUnder(source, 'flowsOrder'),
    };
  });

const CI_FLOWS = ['launch.yaml', ...SHARDS.flatMap((s) => s.flows)];

/** `runFlow: x.yaml` — a subflow inherits its parent's variables. */
function subflowsOf(source: string): string[] {
  return [...source.matchAll(/runFlow:\s*(?:\n\s*file:\s*)?([\w.-]+\.yaml)/g)].map((m) => m[1]);
}

/** `runScript: x.js` — the script sees the same injected variables. */
function runScriptsOf(source: string): string[] {
  return [...source.matchAll(/runScript:\s*(?:\n\s*file:\s*)?([\w.-]+\.js)/g)].map((m) => m[1]);
}

/**
 * Identifiers a `runScript` reads that Maestro must have injected.
 *
 * A script sees `-e` variables as BARE globals, not as `${VAR}` — so the YAML
 * regex above cannot see them, and `TRIP_ID` (added for seed-turn.js) would
 * have been exactly the same class of bug this file exists for: undefined on
 * one runner, silently failing to match, 27 minutes at a time. `read-otp.js`
 * guards `TEST_SECRET` with `typeof`, which is still a reference to a variable
 * a runner has to supply, so `typeof` is deliberately not an exemption.
 *
 * JS built-ins that happen to be all-caps are subtracted rather than matched
 * more cleverly: the list is short, and a narrower regex is how this stops
 * catching the next one.
 */
const JS_GLOBALS = new Set(['JSON', 'URL', 'URLSearchParams', 'NaN', 'Infinity']);

function scriptVars(file: string): Set<string> {
  const vars = new Set<string>();
  const full = path.join(FLOW_DIR, file);
  if (!fs.existsSync(full)) return vars;
  const source = fs
    .readFileSync(full, 'utf8')
    // Strip comments FIRST — these files explain themselves at length, and a
    // variable named only in a paragraph is not a reference.
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    /*
     * And STRING LITERALS, which is not tidiness either. read-otp.js's error
     * messages name `E2E_TEST_ENDPOINTS`, `E2E_TEST_ENDPOINTS_SECRET`, `OTP`
     * and `HTTP` in prose aimed at whoever reads the failure. Matching those
     * reports four variables no runner should ever supply, and a guard that
     * cries wolf gets its expectations widened until it stops guarding.
     */
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
  for (const m of source.matchAll(/\b([A-Z][A-Z0-9_]{2,})\b/g)) {
    if (!JS_GLOBALS.has(m[1])) vars.add(m[1]);
  }
  return vars;
}

/**
 * Comment lines are stripped before matching, and that is not a shortcut.
 *
 * These files carry long comments explaining what they used to do — `${CODE}`
 * appears in `sign-in.yaml` only inside the paragraph explaining why the code is
 * NOT passed in any more. Matching it would report a variable no runner should
 * supply, and a guard that cries wolf gets its expectations widened until it
 * stops guarding anything.
 */
function live(source: string): string {
  return source
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

/** Every `${VAR}` in a flow, including the ones it reaches through runFlow. */
/**
 * Variables a flow hands a script or subflow itself, in the call's `env:` block:
 *
 *   - runScript:
 *       file: seed-account.js
 *       env:
 *         ACCOUNT_SUFFIX: fs
 *
 * Those reach the callee without any runner's `-e`, so they are subtracted from
 * what the callee needs — for THAT call only. Anything the `env:` values
 * themselves reference (`EMAIL: ${EMAIL}`) is still counted, by the `${...}`
 * scan of the calling flow.
 */
function envPassedTo(source: string, callee: string): Set<string> {
  const keys = new Set<string>();
  const commands = source.split(/\n(?=- )/);
  for (const command of commands) {
    if (!/^- run(?:Script|Flow):/.test(command)) continue;
    if (!new RegExp(`file:\\s*${callee.replace(/\./g, '\\.')}\\s*$`, 'm').test(command)) continue;
    const env = command.match(/\n(\s+)env:\s*\n((?:\1\s+[A-Z_][A-Z0-9_]*:.*\n?)+)/);
    if (!env) continue;
    for (const m of env[2].matchAll(/^\s+([A-Z_][A-Z0-9_]*):/gm)) keys.add(m[1]);
  }
  return keys;
}

function varsFor(flow: string, seen = new Set<string>()): Set<string> {
  const vars = new Set<string>();
  if (seen.has(flow)) return vars;
  seen.add(flow);
  const file = path.join(FLOW_DIR, flow);
  if (!fs.existsSync(file)) return vars;
  const source = live(fs.readFileSync(file, 'utf8'));
  for (const m of source.matchAll(/\$\{([A-Z_][A-Z0-9_]*)\}/g)) vars.add(m[1]);
  for (const script of runScriptsOf(source)) {
    const passed = envPassedTo(source, script);
    for (const v of scriptVars(script)) if (!passed.has(v)) vars.add(v);
  }
  for (const sub of subflowsOf(source)) {
    const passed = envPassedTo(source, sub);
    for (const v of varsFor(sub, new Set(seen))) if (!passed.has(v)) vars.add(v);
  }
  return vars;
}

/**
 * `output.*` is Maestro's own, set by a `runScript` step rather than passed in
 * with `-e`. `sign-in.yaml` reads `${output.code}` from `read-otp.js`.
 * Uppercase-only matching already excludes it; this is here so the exclusion is
 * a decision rather than an accident of the regex.
 */
const RUNTIME_PROVIDED = new Set<string>([]);

describe('Maestro flow parameters', () => {
  it('finds the flows and their variables at all', () => {
    // The canary: if the regex or the directory ever stops matching, every
    // assertion below would vacuously pass on an empty set.
    const vars = varsFor('chat-keyboard.yaml');
    expect(vars.size).toBeGreaterThan(2);
    expect(vars.has('APP_ID')).toBe(true);
  });

  it.each(CI_FLOWS)('ci.yml supplies every variable %s needs', (flow) => {
    const missing = [...varsFor(flow)]
      .filter((v) => !RUNTIME_PROVIDED.has(v))
      .filter((v) => !new RegExp(`-e\\s+${v}=`).test(CI));
    expect(
      missing,
      `.github/workflows/ci.yml runs ${flow} without -e for: ${missing.join(', ')}. ` +
        `Maestro does not fail on an undefined variable — it silently fails to match.`
    ).toEqual([]);
  });

  it('ios-e2e-local.sh supplies them too, so local and CI agree', () => {
    /**
     * The half that makes this worth having. A variable present in one runner
     * and not the other is exactly how the bug shipped: green on a laptop, red
     * on every CI run, discovered 27 minutes at a time.
     */
    const all = new Set<string>();
    for (const flow of CI_FLOWS) for (const v of varsFor(flow)) all.add(v);
    const missing = [...all]
      .filter((v) => !RUNTIME_PROVIDED.has(v))
      .filter((v) => !new RegExp(`-e\\s+${v}=`).test(LOCAL));
    expect(
      missing,
      `scripts/ios-e2e-local.sh runs the flows without -e for: ${missing.join(', ')}`
    ).toEqual([]);
  });

  it('finds the shards at all, and each one lists its flows in both places', () => {
    expect(SHARDS.length).toBeGreaterThanOrEqual(2);
    for (const shard of SHARDS) {
      expect(shard.flows.length, `shards/${shard.name}.yaml lists no flows`).toBeGreaterThan(0);
      // `flowsOrder` names flows without the extension. A flow in `flows:` but
      // not in `flowsOrder` still runs, in an order nobody chose; one in
      // `flowsOrder` but not `flows:` silently does not run at all.
      expect(
        [...shard.order].sort(),
        `shards/${shard.name}.yaml: flows and flowsOrder disagree`
      ).toEqual(shard.flows.map((f) => f.replace(/\.yaml$/, '')).sort());
      for (const flow of shard.flows) {
        expect(fs.existsSync(path.join(FLOW_DIR, flow)), `shards/${shard.name}.yaml names missing ${flow}`).toBe(true);
      }
    }
  });

  /**
   * A flow no shard lists is a flow CI never runs — green forever, proving
   * nothing. Subflows (reached by `runFlow` from another flow, like sign-in)
   * must NOT be listed: sign-in spends a single-use code, and running it
   * standalone would leave the next flow's sign-in holding a spent one.
   */
  it('every flow runs in exactly one shard, and no subflow runs on its own', () => {
    const NOT_A_CI_FLOW = new Set(['launch.yaml', 'screenshots.yaml']);
    const all = fs.readdirSync(FLOW_DIR).filter((f) => f.endsWith('.yaml'));
    const subflows = new Set(
      all.flatMap((f) => subflowsOf(live(fs.readFileSync(path.join(FLOW_DIR, f), 'utf8'))))
    );
    const listed = SHARDS.flatMap((s) => s.flows);
    for (const flow of all) {
      if (NOT_A_CI_FLOW.has(flow)) continue;
      const count = listed.filter((f) => f === flow).length;
      if (subflows.has(flow)) {
        expect(count, `${flow} is a subflow and must not be listed in a shard`).toBe(0);
      } else {
        expect(count, `${flow} is in ${count} shards; it must be in exactly one`).toBe(1);
      }
    }
  });

  it('ci.yml runs launch.yaml, then each shard through its own config', () => {
    expect(CI).toMatch(/test mobile\/maestro\/launch\.yaml/);
    expect(CI).toMatch(/test mobile\/maestro \\\n\s+--config "mobile\/maestro\/shards\/\$SHARD\.yaml"/);
    expect(CI).toContain("fs.readdirSync('mobile/maestro/shards')");
  });

  it('the fixture emits the trip name rather than anyone restating it', () => {
    // TRIP_NAME has to come from the thing that seeded the trip. A literal in
    // ci.yml would be a second copy, free to drift from what was written.
    const fixture = fs.readFileSync(path.join(ROOT, 'scripts/ios-e2e-fixture.mjs'), 'utf8');
    expect(fixture).toMatch(/TRIP_NAME=\$\{tripName\}/);
    expect(CI).toMatch(/-e\s+TRIP_NAME="\$TRIP_NAME"/);
  });
});
