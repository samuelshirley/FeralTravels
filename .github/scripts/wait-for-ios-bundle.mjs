#!/usr/bin/env node
/**
 * Wait for this run's iOS bundle, then name the ONE artifact a shard may use.
 *
 * Run by every `iOS e2e · <shard>` job in ci.yml. Prints `artifact_id=<id>`
 * and `artifact_name=<name>` to $GITHUB_OUTPUT when the bundle is ready; exits
 * non-zero when it never will be.
 *
 * WHY A WAIT AND NOT `needs:` (2026-11-12). A shard used to `need` the preview,
 * so it started only once the preview was up (~5 min in) and THEN spent
 * 4-14 minutes on setup — simulator boot, setup-node, `npm ci`, a Metro bundle,
 * install — before its first flow. Now a shard needs only `ios-build` and does
 * that setup while the preview deploys; the one thing it cannot do early is
 * install the JavaScript built for the preview, which `iOS bundle` makes, once,
 * on Linux. A `needs:` on that job would put the shard's whole setup back
 * behind it. So the shard starts early and waits here, at the last moment.
 *
 * WHY THE ARTIFACT IS CHOSEN BY TIME, NOT BY NAME. The bundle carries the
 * preview's URL, and a bundle for ANOTHER preview fails as a fake sign-out (its
 * database is gone — deploy-pipeline.md). Re-runs are where that could happen,
 * and GitHub's API was read rather than assumed (runs 42382766969 and
 * 42387577080): on "Re-run failed jobs", jobs that are NOT re-run are carried
 * into the new attempt's job list with `run_attempt` rewritten to the new
 * attempt and their ORIGINAL `started_at`. So `run_attempt` cannot tell a fresh
 * bundle job from a carried one, and a fixed artifact name could be the
 * previous attempt's. What can: the artifact must have been CREATED INSIDE the
 * [started_at, completed_at] of the bundle job this attempt lists. A carried
 * job matches the artifact it made (for the preview that was carried with it);
 * a re-run job matches only the artifact it made itself.
 *
 * A bundle job that ends in anything but `success` (including `skipped`, when
 * the preview failed) fails the shard at once, naming it. The fail-fast
 * watcher will usually have cancelled the run first.
 *
 * Shape as fail-fast.mjs: `decide` is pure and `wait` takes an `io` whose
 * `gh(args)` is the only way out, so src/lib/iosBundleWait.test.ts drives both
 * against a stubbed GitHub.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** The bundle job's `name:` in ci.yml (iosBundleWait.test.ts holds them equal). */
export const BUNDLE_JOB = "iOS bundle (this preview's JavaScript)";
/** Its artifact is `${ARTIFACT_PREFIX}${github.run_attempt}`. */
export const ARTIFACT_PREFIX = 'ios-bundle-';
export const POLL_MS = 10_000;
/** A finished, green bundle job whose artifact has not appeared by now never uploaded one. */
export const ARTIFACT_GRACE_MS = 120_000;

/** @param {string | null | undefined} iso */
const ms = (iso) => (iso ? Date.parse(iso) : NaN);

/**
 * @typedef {{ name: string, status?: string, conclusion?: string | null, started_at?: string | null, completed_at?: string | null }} Job
 * @typedef {{ id: number, name: string, created_at: string, expired?: boolean }} Artifact
 * @typedef {{ action: 'wait', why: string }
 *   | { action: 'fail', why: string }
 *   | { action: 'ready', artifact: Artifact }
 *   | { action: 'no-artifact', why: string }} Decision
 */

/**
 * @param {Job[]} jobs this attempt's jobs
 * @param {Artifact[]} artifacts this run's artifacts
 * @returns {Decision}
 */
export function decide(jobs, artifacts, job = BUNDLE_JOB, prefix = ARTIFACT_PREFIX) {
  const j = jobs.find((x) => x.name === job);
  if (!j) return { action: 'wait', why: `${job} is not listed yet (it waits for the preview)` };
  if (j.status !== 'completed') return { action: 'wait', why: `${job} is ${j.status}` };
  if (j.conclusion !== 'success') {
    return { action: 'fail', why: `${job} concluded ${j.conclusion} — there is no JavaScript for this preview. Start with that job (or Deploy tested preview).` };
  }
  const from = ms(j.started_at);
  const to = ms(j.completed_at);
  if (Number.isNaN(from) || Number.isNaN(to)) {
    return { action: 'fail', why: `${job} is complete but has no start/end time to match its artifact against` };
  }
  const mine = artifacts
    .filter((a) => a.name.startsWith(prefix) && !a.expired)
    .filter((a) => {
      const t = ms(a.created_at);
      return t >= from && t <= to;
    })
    .sort((a, b) => ms(b.created_at) - ms(a.created_at));
  if (mine.length === 0) {
    return { action: 'no-artifact', why: `${job} finished green but no ${prefix}* artifact was created between ${j.started_at} and ${j.completed_at}` };
  }
  return { action: 'ready', artifact: mine[0] };
}

/**
 * @typedef {{
 *   gh: (args: string[]) => { ok: boolean, stdout: string, stderr: string },
 *   sleep: (ms: number) => void,
 *   now: () => number,
 *   log: (line: string) => void,
 * }} Io
 */

/** @param {string} stdout one JSON object per line */
const lines = (stdout) => stdout.split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l));

/**
 * @param {{ repo: string, runId: string, attempt: string, io: Io, pollMs?: number, deadlineMs: number, graceMs?: number }} o
 * @returns {{ ok: true, artifact: Artifact } | { ok: false, why: string }}
 */
export function wait({ repo, runId, attempt, io, pollMs = POLL_MS, deadlineMs, graceMs = ARTIFACT_GRACE_MS }) {
  const start = io.now();
  /** @type {number | null} */
  let noArtifactSince = null;
  let lastWhy = '';
  for (;;) {
    const jr = io.gh(['api', '--paginate', `repos/${repo}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`,
      '--jq', '.jobs[] | {name, status, conclusion, started_at, completed_at} | tojson']);
    const ar = io.gh(['api', '--paginate', `repos/${repo}/actions/runs/${runId}/artifacts?per_page=100`,
      '--jq', '.artifacts[] | {id, name, created_at, expired} | tojson']);
    /** @type {Decision | null} */
    let d = null;
    if (!jr.ok || !ar.ok) {
      io.log(`::warning::Could not read this run's jobs or artifacts, polling again: ${(jr.stderr || ar.stderr).trim()}`);
    } else {
      try {
        d = decide(lines(jr.stdout), lines(ar.stdout));
      } catch (e) {
        io.log(`::warning::Could not parse the API response, polling again: ${/** @type {Error} */ (e).message}`);
      }
    }
    if (d) {
      if (d.action === 'ready') return { ok: true, artifact: d.artifact };
      if (d.action === 'fail') return { ok: false, why: d.why };
      if (d.action === 'no-artifact') {
        // The artifact list can trail the job's completion by a few seconds.
        noArtifactSince ??= io.now();
        if (io.now() - noArtifactSince >= graceMs) return { ok: false, why: d.why };
      } else {
        noArtifactSince = null;
      }
      if (d.why !== lastWhy) io.log(`${new Date(io.now()).toISOString()} waiting: ${d.why}`);
      lastWhy = d.why;
    }
    if (io.now() - start >= deadlineMs) {
      return { ok: false, why: `no bundle after ${Math.round(deadlineMs / 60_000)} min (last: ${lastWhy || 'no API answer'})` };
    }
    io.sleep(pollMs);
  }
}

/** @param {Record<string, string | undefined>} env @returns {Io} */
export function realIo(env) {
  return {
    gh(args) {
      try {
        const stdout = execFileSync('gh', args, {
          encoding: 'utf8',
          env: { ...env, GH_PROMPT_DISABLED: '1' },
          stdio: ['ignore', 'pipe', 'pipe'],
          maxBuffer: 16 * 1024 * 1024,
        });
        return { ok: true, stdout, stderr: '' };
      } catch (e) {
        const err = /** @type {{ stdout?: string, stderr?: string, message: string }} */ (e);
        return { ok: false, stdout: err.stdout ?? '', stderr: err.stderr || err.message };
      }
    },
    sleep(ms) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    },
    now: () => Date.now(),
    log: (line) => console.log(line),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = process.env;
  const r = wait({
    repo: env.GITHUB_REPOSITORY ?? '',
    runId: env.GITHUB_RUN_ID ?? '',
    attempt: env.GITHUB_RUN_ATTEMPT ?? '1',
    io: realIo(env),
    deadlineMs: Number(env.IOS_BUNDLE_DEADLINE_MINUTES ?? '35') * 60_000,
  });
  if (!r.ok) {
    console.log(`::error::${r.why}`);
    process.exit(1);
  }
  console.log(`Bundle ready: ${r.artifact.name} (artifact ${r.artifact.id}, created ${r.artifact.created_at})`);
  if (env.GITHUB_OUTPUT) {
    appendFileSync(env.GITHUB_OUTPUT, `artifact_id=${r.artifact.id}\nartifact_name=${r.artifact.name}\n`);
  }
}
