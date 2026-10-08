#!/usr/bin/env node
/**
 * Fail fast: stop a CI run at its first failed job.
 *
 * Run by ci.yml's `fail-fast` job (`Stop the run at the first failure`), which
 * starts with the run (no `needs`) and polls this run attempt's jobs every
 * ~15 s. The moment any job other than itself and the two jobs that run after
 * a cancel by design has concluded `failure`, it cancels the run.
 *
 * WHY A WATCHER, and not a stop step in each job (which is what ci.yml had
 * first). `gh run cancel` cancels every job that has not completed — INCLUDING
 * the one that asked. A failed job cancelling the run from its own last step
 * is still running, so its own conclusion is rewritten from `failure` to
 * `cancelled`. Run 36988769859 (2026-10-02): `iOS e2e · account` failed, its
 * stop step cancelled the run, and the job came out `cancelled` like every
 * other — the run showed "everything cancelled, nothing failed", the iOS PR
 * comment could not name a failed job, and the cause was hidden. A watcher
 * cancels only after the failed job has COMPLETED, so that job keeps
 * `failure` in the checks list and in the PR comment.
 *
 * Never turns a run red: every outcome exits 0, a GitHub API error is a
 * warning and another poll, and ci.yml puts `continue-on-error` on the step.
 *
 * ── Shape ──────────────────────────────────────────────────────────────────
 *
 * `decide` is pure (jobs → cancel | wait | done) and `watch` takes an `io`
 * whose `gh(args)` is the only way out of the process — the same arrangement
 * as auto-merge.mjs — so src/lib/ciFailFast.test.ts drives both against a
 * stubbed GitHub.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** This job's `name:` in ci.yml. */
export const SELF_JOB = 'Stop the run at the first failure';

/**
 * ci.yml's jobs that run AFTER a cancel by design (`if: always()`): they
 * report on the run, so they are never the cause, and the watcher must not wait
 * on them (they start only once everything they need has finished).
 */
export const REPORTING_JOBS = ['iOS e2e (simulator)', 'Drop the preview database if the PR has closed'];

/** Job conclusions that mean the job itself failed. `cancelled` is not one. */
const FAILED = new Set(['failure', 'timed_out']);

export const POLL_MS = 15_000;

/**
 * What the run's jobs say to do now.
 *
 * `done` needs every reporting job to have APPEARED as well as every other job
 * to have completed. A job waiting on `needs` (and every shard of a matrix
 * built from another job's output) may not be listed until its needs finish,
 * so "everything listed is complete" can be true between two stages. The
 * reporting jobs come last — ciFailFast.test.ts holds that every other job is
 * one of their needs, or needs only such jobs — so once they are listed,
 * nothing else is still to come.
 *
 * @param {{ name: string, status?: string, conclusion?: string | null }[]} jobs
 * @param {string} [self]
 * @param {string[]} [reporting]
 * @returns {{ action: 'cancel', failed: string[] } | { action: 'wait' } | { action: 'done' }}
 */
export function decide(jobs, self = SELF_JOB, reporting = REPORTING_JOBS) {
  const others = jobs.filter((j) => j.name !== self && !reporting.includes(j.name));
  const failed = others.filter((j) => FAILED.has(String(j.conclusion))).map((j) => j.name);
  if (failed.length > 0) return { action: 'cancel', failed };
  const allComplete = others.every((j) => j.status === 'completed');
  const reportersListed = reporting.every((name) => jobs.some((j) => j.name === name));
  return allComplete && reportersListed ? { action: 'done' } : { action: 'wait' };
}

/**
 * @typedef {{
 *   gh: (args: string[]) => { ok: boolean, stdout: string, stderr: string },
 *   sleep: (ms: number) => void,
 *   now: () => number,
 *   log: (line: string) => void,
 *   summary: (line: string) => void,
 * }} Io
 */

/** @param {string} stdout one `{name,status,conclusion}` JSON object per line */
function parseJobs(stdout) {
  return stdout
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l));
}

/**
 * Poll until the run fails, finishes green, or the deadline passes.
 *
 * @param {{ repo: string, runId: string, attempt: string, io: Io, pollMs?: number, deadlineMs: number }} o
 * @returns {{ action: 'cancel', failed: string[] } | { action: 'done' } | { action: 'deadline' }}
 */
export function watch({ repo, runId, attempt, io, pollMs = POLL_MS, deadlineMs }) {
  const start = io.now();
  const jobsArgs = [
    'api', '--paginate',
    `repos/${repo}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`,
    '--jq', '.jobs[] | {name, status, conclusion} | tojson',
  ];
  for (;;) {
    const r = io.gh(jobsArgs);
    let jobs = null;
    if (!r.ok) {
      io.log(`::warning::Could not read this run's jobs, polling again: ${r.stderr.trim()}`);
    } else {
      try {
        jobs = parseJobs(r.stdout);
      } catch (e) {
        io.log(`::warning::Could not parse this run's jobs, polling again: ${/** @type {Error} */ (e).message}`);
      }
    }
    if (jobs) {
      const d = decide(jobs);
      if (d.action === 'cancel') {
        const names = d.failed.map((n) => `\`${n}\``).join(', ');
        // Summary and notice BEFORE the cancel: the cancel stops this job too.
        io.summary(`### ⛔ ${names} failed, so the rest of this run was cancelled`);
        io.summary('');
        io.summary('Start with that failure. A job cancelled after it says nothing about this commit.');
        io.log(`::notice::${d.failed.join(', ')} failed — cancelling the rest of the run.`);
        const c = io.gh(['run', 'cancel', String(runId), '-R', repo]);
        if (!c.ok) {
          // The run had already finished, or a new push cancelled it first.
          if (/cancel|completed/i.test(c.stderr)) io.log(`::notice::gh run cancel: ${c.stderr.trim()}`);
          else io.log(`::warning::Could not cancel the rest of the run: ${c.stderr.trim()}`);
        }
        return d;
      }
      if (d.action === 'done') {
        io.log('Every job finished and none failed; nothing to stop.');
        return d;
      }
    }
    if (io.now() - start >= deadlineMs) {
      io.log('::warning::The run is still going at the watcher\'s deadline; it stops watching (fail-fast is off for the rest of this run).');
      return { action: 'deadline' };
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
    summary(line) {
      if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${line}\n`);
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = process.env;
  try {
    watch({
      repo: env.GITHUB_REPOSITORY ?? '',
      runId: env.GITHUB_RUN_ID ?? '',
      attempt: env.GITHUB_RUN_ATTEMPT ?? '1',
      io: realIo(env),
      deadlineMs: Number(env.FAIL_FAST_DEADLINE_MINUTES ?? '165') * 60_000,
    });
  } catch (e) {
    console.log(`::warning::fail-fast watcher stopped: ${/** @type {Error} */ (e).message}`);
  }
  process.exit(0);
}
