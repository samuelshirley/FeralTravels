/**
 * Decides whether an iOS shard gets ONE more go at the flows that failed, and
 * writes the Maestro config for it.
 *
 * WHY A RE-RUN, AND WHY SO NARROW.
 *
 * Two simulator failures broke five shard jobs between 2026-11-04 and 11-13,
 * and neither is the app:
 *
 *   - FRONTBOARD. `launchApp: clearState` reinstalls the app, and now and then
 *     `simctl launch` runs before iOS has registered the reinstall:
 *     `Application "com.feraltravels.ios" is unknown to FrontBoard`. The
 *     `retry:` that 4f23a18 wrapped round that launch in sign-in.yaml cannot
 *     catch it: Maestro 2.10.0's retryCommand catches only MaestroException,
 *     and a failed `simctl launch` throws IllegalStateException
 *     (CommandLineUtils.kt:47). Run 43449367820 proves it: one launch, then
 *     "Retry 2 times FAILED".
 *   - DRIVER DEATH. The XCTest runner stops answering mid-shard
 *     (`Device became unreachable`, an EOFException underneath), and every
 *     later flow then fails in under a second. Nov 4 `flows` lost five flows
 *     to it, Nov 7 `flows` nine.
 *
 * So the re-run fires ONLY on one of those signatures, re-runs ONLY the flows
 * that failed, and only ONCE. The signatures are read from the failed flows'
 * OWN evidence — their JUnit failure text and their `maestro.log` under
 * `--debug-output` — NOT from Maestro's console: the console says only
 * "[Failed] chat-tab-in-flight (51s) (Unknown error)", and the FrontBoard line
 * exists only in that flow's maestro.log. Anything else is the app
 * and fails the job, exactly as before: a blanket retry is how a regression
 * turns into "flaky". A flow that is genuinely broken fails its re-run too and
 * the job still goes red; the cost of the re-run is that a bug which fails
 * only SOMETIMES, in the same run as a simulator flake, can slip through once.
 * Every re-run is named in the PR comment so that is visible.
 *
 * THE SIGN-IN CODE BUDGET. A re-run signs in again from the same runner, so
 * it spends codes against the same per-IP limit (src/lib/ipLimit.ts, 10 an
 * hour). Going over is not a flake, it is a guaranteed failure that reads like
 * one (read-otp.js: "no pending code"), so the re-run is refused, with that
 * reason, when the shard's first run plus the re-run plus the reserve for
 * sign-in-otp.yaml's own retry would not fit. maestroOtpBudget.test.ts counts
 * the same way, from the same functions below.
 *
 *   node scripts/maestro-rerun.mjs <shard> <junit.xml> <debug-output-dir> <out-config.yaml>
 *
 * Exit 0: a re-run is planned, the config is written, and the reason and flows
 * are on stdout as `reason=...` / `flows=...`. Exit 1: no re-run; why is on
 * stderr.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const MAESTRO_DIR = path.join(process.cwd(), 'mobile', 'maestro');

/** src/lib/ipLimit.ts `otp_send` — maestroOtpBudget.test.ts holds them equal. */
export const OTP_SENDS_PER_HOUR = 10;

/** sign-in-otp.yaml retries its send once, which can spend one more code. */
export const SIGN_IN_RETRY_RESERVE = 1;

/** A failure in the harness, never the app. Matched against Maestro's own output. */
export const HARNESS_SIGNATURES = [
  { reason: 'the app launch raced its reinstall (unknown to FrontBoard)', pattern: /is unknown to FrontBoard/ },
  { reason: 'the XCTest driver died mid-shard', pattern: /Device became unreachable|XCUITestServerError\$Unreachable/ },
];

const SEND_FLOW = 'sign-in-otp.yaml';
const SEND_TAP = /^- tapOn:\s*'(Email me a 6-digit code|Resend code)'/gm;

function live(file, dir) {
  return readFileSync(path.join(dir, file), 'utf8')
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');
}

function subflows(src) {
  const out = [];
  for (const m of src.matchAll(/^- runFlow:\s*(\S+\.yaml)\s*$/gm)) out.push(m[1]);
  for (const m of src.matchAll(/^- runFlow:\s*\n\s+file:\s*(\S+\.yaml)\s*$/gm)) out.push(m[1]);
  return out;
}

/**
 * Sign-in codes one run of `file` sends: its sign-in-otp.yaml runs, followed
 * through every `runFlow`, plus any direct tap on "Email me a 6-digit code" or
 * "Resend code" outside that subflow.
 */
export function sendsOf(file, dir = MAESTRO_DIR, seen = []) {
  if (file === SEND_FLOW) return 1;
  if (seen.includes(file)) throw new Error(`runFlow cycle: ${[...seen, file].join(' → ')}`);
  const src = live(file, dir);
  let n = [...src.matchAll(SEND_TAP)].length;
  for (const sub of subflows(src)) n += sendsOf(sub, dir, [...seen, file]);
  return n;
}

/** The flow files a shard config lists under `flows:`, in order. */
export function shardFlows(shard, dir = MAESTRO_DIR) {
  const src = readFileSync(path.join(dir, 'shards', shard), 'utf8');
  const block = src.split(/^executionOrder:/m)[0];
  return [...block.matchAll(/^\s+- (\S+\.yaml)\s*$/gm)].map((m) => m[1]);
}

/** Codes a shard's whole first run sends, launch.yaml included (CI runs it first). */
export function shardSends(shard, dir = MAESTRO_DIR) {
  return ['launch.yaml', ...shardFlows(shard, dir)].reduce((n, f) => n + sendsOf(f, dir), 0);
}

/** Flow files the JUnit report marks as anything but SUCCESS. */
export function failedFlows(junit) {
  const out = [];
  for (const m of junit.matchAll(/<testcase\b([^>]*)>/g)) {
    const attrs = m[1];
    const file = attrs.match(/\bfile="([^"]+)"/)?.[1];
    const status = attrs.match(/\bstatus="([^"]+)"/)?.[1];
    if (file && status && status !== 'SUCCESS') out.push(path.basename(file));
  }
  return out;
}

/**
 * Every `maestro.log` Maestro wrote for these flows under `--debug-output`
 * (`<dir>/.maestro/tests/<timestamp>/<flow>/logs/maestro.log`), joined. A
 * walk, not a glob: the tree starts with a dot directory.
 */
export function flowLogs(debugDir, flows) {
  const names = new Set(flows.map((f) => f.replace(/\.yaml$/, '')));
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === 'maestro.log' && path.basename(path.dirname(p)) === 'logs' && names.has(path.basename(path.dirname(path.dirname(p))))) {
        out.push(readFileSync(p, 'utf8'));
      }
    }
  };
  walk(debugDir);
  return out.join('\n');
}

/**
 * The decision, pure: `{ rerun: true, reason, flows }` or `{ rerun: false, why }`.
 */
export function planRerun({ shard, junit, log, dir = MAESTRO_DIR }) {
  const signature = HARNESS_SIGNATURES.find((s) => s.pattern.test(log));
  if (!signature) return { rerun: false, why: 'no simulator-failure signature in the output: this is the app, not the harness' };

  const order = shardFlows(shard, dir);
  const failed = failedFlows(junit);
  if (failed.length === 0) return { rerun: false, why: 'the report names no failed flow, so there is nothing to re-run' };
  const unknown = failed.filter((f) => !order.includes(f));
  if (unknown.length) return { rerun: false, why: `the report names flows this shard does not list: ${unknown.join(', ')}` };
  const flows = order.filter((f) => failed.includes(f));

  const first = shardSends(shard, dir);
  const again = flows.reduce((n, f) => n + sendsOf(f, dir), 0);
  if (first + again + SIGN_IN_RETRY_RESERVE > OTP_SENDS_PER_HOUR) {
    return {
      rerun: false,
      why: `re-running ${flows.join(', ')} would send ${again} more sign-in codes on top of ${first}; this runner may send ${OTP_SENDS_PER_HOUR} an hour, ${SIGN_IN_RETRY_RESERVE} kept for sign-in's own retry`,
    };
  }
  return { rerun: true, reason: signature.reason, flows };
}

/** The Maestro config for the re-run: the same shape as a shard file. */
export function rerunConfig(flows) {
  const names = flows.map((f) => f.replace(/\.yaml$/, ''));
  return [
    '# Written by scripts/maestro-rerun.mjs in CI. Not a shard: never committed.',
    'flows:',
    ...flows.map((f) => `  - ${f}`),
    'executionOrder:',
    '  continueOnFailure: true',
    '  flowsOrder:',
    ...names.map((n) => `    - ${n}`),
    '',
  ].join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [shard, junitPath, debugDir, outPath] = process.argv.slice(2);
  let plan;
  try {
    const junit = readFileSync(junitPath, 'utf8');
    // The JUnit's own <failure> text carries the driver-death line.
    const log = `${junit}\n${flowLogs(debugDir, failedFlows(junit))}`;
    plan = planRerun({ shard: `${shard}.yaml`, junit, log });
  } catch (error) {
    plan = { rerun: false, why: `could not plan a re-run: ${error.message}` };
  }
  if (!plan.rerun) {
    process.stderr.write(`No re-run: ${plan.why}\n`);
    process.exit(1);
  }
  writeFileSync(outPath, rerunConfig(plan.flows));
  process.stdout.write(`reason=${plan.reason}\nflows=${plan.flows.join(' ')}\n`);
}
