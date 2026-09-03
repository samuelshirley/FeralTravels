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
const CI_FLOWS = ['launch.yaml', 'chat-keyboard.yaml'];

/** `runFlow: x.yaml` — a subflow inherits its parent's variables. */
function subflowsOf(source: string): string[] {
  return [...source.matchAll(/runFlow:\s*(?:\n\s*file:\s*)?([\w.-]+\.yaml)/g)].map((m) => m[1]);
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
function varsFor(flow: string, seen = new Set<string>()): Set<string> {
  const vars = new Set<string>();
  if (seen.has(flow)) return vars;
  seen.add(flow);
  const file = path.join(FLOW_DIR, flow);
  if (!fs.existsSync(file)) return vars;
  const source = live(fs.readFileSync(file, 'utf8'));
  for (const m of source.matchAll(/\$\{([A-Z_][A-Z0-9_]*)\}/g)) vars.add(m[1]);
  for (const sub of subflowsOf(source)) {
    for (const v of varsFor(sub, seen)) vars.add(v);
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

  it('the fixture emits the trip name rather than anyone restating it', () => {
    // TRIP_NAME has to come from the thing that seeded the trip. A literal in
    // ci.yml would be a second copy, free to drift from what was written.
    const fixture = fs.readFileSync(path.join(ROOT, 'scripts/ios-e2e-fixture.mjs'), 'utf8');
    expect(fixture).toMatch(/TRIP_NAME=\$\{tripName\}/);
    expect(CI).toMatch(/-e\s+TRIP_NAME="\$TRIP_NAME"/);
  });
});
