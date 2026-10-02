import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
// Plain ESM JS — same arrangement as autoMerge.test.ts.
import * as failFast from '../../.github/scripts/fail-fast.mjs';

/**
 * CI fails fast (Sam, 2026-10-02): "If anything fails on the PR, immediately
 * stop the rest of the jobs and investigate the failure so we aren't wasting
 * time or tokens."
 *
 * The first version ended every job with a `Stop the whole run` step that ran
 * `gh run cancel` on its own run. That cancels every job not yet complete —
 * including the one asking — so the failed job's own conclusion was rewritten
 * from `failure` to `cancelled`. Run 36988769859: `iOS e2e · account` failed,
 * cancelled the run, came out `cancelled`, and nothing in the run showed as
 * failed; the iOS comment could not name the cause.
 *
 * Now ONE watcher job (`Stop the run at the first failure`,
 * .github/scripts/fail-fast.mjs) polls the run's jobs and cancels only after a
 * failed job has completed, so that job keeps `failure`. This file holds:
 * ci.yml's shape (one watcher, nobody else cancels), fail-fast.mjs's decision
 * and loop against a stubbed GitHub, and the iOS PR comment's script, run for
 * real against the run 36988769859 shape.
 *
 * There is no YAML parser in the dependency tree, and ci.yml's layout is
 * regular (2-space indent, steps at 6), so `parseWorkflow` reads just the
 * structure these checks need. The first test proves it found the jobs, so a
 * layout change fails loudly instead of passing on nothing.
 */

const { SELF_JOB, REPORTING_JOBS, decide, watch } = failFast;

const ROOT = path.resolve(__dirname, '../..');
const CI = readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');

const WATCHER = 'fail-fast';
/** Run after a cancel by design (`if: always()`): they report, they never cause. */
const AFTER_CANCEL_JOBS = ['ios-e2e-summary', 'drop-preview-db'];

type Step = { text: string; fields: Record<string, string>; env: Record<string, string> };
type Job = { id: string; fields: Record<string, string>; failFast?: string; steps: Step[] };

function split(s: string): [string, string] {
  const m = s.trim().match(/^([^:]+):\s?(.*)$/);
  return m ? [m[1].trim(), m[2].trim()] : [s.trim(), ''];
}

function parseWorkflow(src: string) {
  const permissions: Record<string, string> = {};
  const jobs: Job[] = [];
  let section = '';
  let job: Job | null = null;
  let step: Step | null = null;
  let inSteps = false;
  let inStrategy = false;
  let inEnv = false;
  for (const line of src.split('\n')) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    if (indent === 0) {
      section = split(line)[0];
      job = null;
      continue;
    }
    if (section === 'permissions' && indent === 2) {
      const [k, v] = split(line);
      permissions[k] = v;
      continue;
    }
    if (section !== 'jobs') continue;
    if (indent === 2) {
      job = { id: split(line)[0], fields: {}, steps: [] };
      jobs.push(job);
      step = null;
      inSteps = inStrategy = false;
      continue;
    }
    if (!job) continue;
    if (indent === 4) {
      const [k, v] = split(line);
      job.fields[k] = v;
      inSteps = k === 'steps';
      inStrategy = k === 'strategy';
      step = null;
      continue;
    }
    if (inStrategy && indent === 6) {
      const [k, v] = split(line);
      if (k === 'fail-fast') job.failFast = v;
      continue;
    }
    if (!inSteps) continue;
    if (indent === 6 && line.trimStart().startsWith('- ')) {
      step = { text: `${line}\n`, fields: {}, env: {} };
      job.steps.push(step);
      const [k, v] = split(line.trimStart().slice(2));
      step.fields[k] = v;
      inEnv = k === 'env';
      continue;
    }
    if (!step) continue;
    step.text += `${line}\n`;
    if (indent === 8) {
      const [k, v] = split(line);
      step.fields[k] = v;
      inEnv = k === 'env';
    } else if (inEnv && indent === 10) {
      const [k, v] = split(line);
      step.env[k] = v;
    }
  }
  return { permissions, jobs };
}

const needsOf = (j: Job) =>
  (j.fields.needs ?? '').replace(/[[\]]/g, '').split(',').map((s) => s.trim()).filter(Boolean);

const cancels = (s: Step) => /gh run cancel|fail-fast\.mjs/.test(s.text);

/**
 * Every job that could cancel this run other than the watcher, one line each;
 * [] when only the watcher can. The regression check for run 36988769859.
 */
function selfCancelProblems(src: string): string[] {
  const problems: string[] = [];
  for (const job of parseWorkflow(src).jobs) {
    const n = job.steps.filter(cancels).length;
    if (job.id === WATCHER) {
      if (n !== 1) problems.push(`${job.id}: has ${n} cancelling steps, needs exactly 1`);
    } else if (n > 0) {
      problems.push(`${job.id}: cancels the run from inside itself, which rewrites its own failure as cancelled`);
    }
  }
  return problems;
}

const wf = parseWorkflow(CI);
const jobById = (id: string) => {
  const j = wf.jobs.find((x) => x.id === id);
  if (!j) throw new Error(`ci.yml has no job ${id}`);
  return j;
};
const summaryComment = () => {
  const s = jobById('ios-e2e-summary').steps.find((x) => x.fields.name === 'Comment iOS results on the PR');
  if (!s) throw new Error('the iOS summary has no comment step');
  return s;
};

describe('ci.yml fails fast through one watcher job', () => {
  it('the parser sees every job (so the checks below are not passing on nothing)', () => {
    expect(wf.jobs.map((j) => j.id)).toEqual([
      'fail-fast', 'decide', 'unit', 'mobile', 'preview', 'e2e', 'ios-build', 'ios-e2e', 'ios-e2e-summary', 'drop-preview-db',
    ]);
    for (const j of wf.jobs) expect(j.steps.length, j.id).toBeGreaterThan(0);
  });

  it('only the watcher cancels the run — no job cancels itself (run 36988769859)', () => {
    expect(selfCancelProblems(CI)).toEqual([]);
  });

  it('the watcher starts with the run, can never turn it red, and outlasts it', () => {
    const w = jobById(WATCHER);
    expect(w.fields.name).toBe(SELF_JOB);
    expect(w.fields.needs).toBeUndefined();
    expect(w.fields.if).toBeUndefined();
    expect(Number(w.fields['timeout-minutes'])).toBeGreaterThanOrEqual(150);
    const poll = w.steps.find(cancels);
    expect(poll?.fields.run).toBe('node .github/scripts/fail-fast.mjs');
    expect(poll?.fields['continue-on-error']).toBe('true');
    expect(poll?.env.GH_TOKEN).toBe('${{ github.token }}');
    // Deadlines nest: the script stops first, the step before the job.
    const script = Number(poll?.env.FAIL_FAST_DEADLINE_MINUTES?.replace(/'/g, ''));
    const stepTimeout = Number(poll?.fields['timeout-minutes']);
    expect(script).toBeGreaterThanOrEqual(150);
    expect(script).toBeLessThan(stepTimeout);
    expect(stepTimeout).toBeLessThan(Number(w.fields['timeout-minutes']));
    // It checks out only the script it runs.
    const checkout = w.steps.find((s) => s.fields.uses?.startsWith('actions/checkout'));
    expect(checkout?.text).toContain('sparse-checkout: .github/scripts');
  });

  it('the token may cancel the run, and nothing else was widened or dropped', () => {
    expect(wf.permissions).toEqual({ contents: 'read', 'pull-requests': 'write', actions: 'write' });
  });

  it('the iOS matrix is fail-fast too: a red shard cancels its siblings', () => {
    expect(jobById('ios-e2e').failFast).toBe('true');
  });

  it('a new push still cancels the run in flight (the concurrency group is untouched)', () => {
    expect(CI).toMatch(/^concurrency:\n {2}group: ci-pr-\$\{\{ github\.event\.pull_request\.number \}\}\n {2}cancel-in-progress: true$/m);
  });

  it("fail-fast.mjs's names are ci.yml's: its own job and the after-cancel jobs", () => {
    expect(REPORTING_JOBS).toEqual(AFTER_CANCEL_JOBS.map((id) => jobById(id).fields.name));
    for (const id of AFTER_CANCEL_JOBS) expect(jobById(id).fields.if, id).toMatch(/^always\(\) && /);
  });

  it("once the after-cancel jobs are listed, no other job is still to come (fail-fast.mjs's `done`)", () => {
    // A job is listed once its needs have finished. Every job is either needed
    // (transitively) by an after-cancel job, or needs only such jobs — so it
    // exists by the time they do, and the watcher cannot call a run done early.
    const ancestors = new Set<string>();
    const visit = (id: string) => {
      for (const n of needsOf(jobById(id))) if (!ancestors.has(n)) (ancestors.add(n), visit(n));
    };
    AFTER_CANCEL_JOBS.forEach(visit);
    for (const j of wf.jobs) {
      if (j.id === WATCHER || AFTER_CANCEL_JOBS.includes(j.id) || ancestors.has(j.id)) continue;
      expect(needsOf(j).every((n) => ancestors.has(n)), `${j.id} needs ${needsOf(j)}`).toBe(true);
    }
  });

  it("the iOS comment leaves out the watcher and the after-cancel jobs, by their real names", () => {
    const set = summaryComment().text.match(/const afterCancel = new Set\((\[.*\])\);/);
    expect(set).not.toBeNull();
    const names: string[] = JSON.parse((set?.[1] ?? '[]').replace(/'/g, '"'));
    expect(new Set(names)).toEqual(new Set([SELF_JOB, ...REPORTING_JOBS]));
    const all = wf.jobs.map((j) => j.fields.name);
    for (const n of names) expect(all, n).toContain(n);
  });

  it('the iOS summary still writes its comment in a cancelled run', () => {
    // A step's default condition is success(), which is false once the run is
    // cancelled: without always() the comment would silently not be written.
    const summary = jobById('ios-e2e-summary');
    const download = summary.steps.find((s) => s.fields.uses?.startsWith('actions/download-artifact'));
    expect(download?.fields.if).toBe('always()');
    expect(summaryComment().fields.if).toBe("always() && github.event_name == 'pull_request'");
  });

  describe('the check itself catches', () => {
    it('a job given its own `gh run cancel` again', () => {
      const added = CI.replace(
        '      - run: npm test\n',
        '      - run: npm test\n      - if: failure()\n        run: gh run cancel ${{ github.run_id }}\n',
      );
      expect(added).not.toBe(CI);
      expect(selfCancelProblems(added)).toEqual([
        'unit: cancels the run from inside itself, which rewrites its own failure as cancelled',
      ]);
    });

    it('the watcher losing its poll step', () => {
      const gone = CI.replace('        run: node .github/scripts/fail-fast.mjs\n', '        run: echo nothing\n');
      expect(gone).not.toBe(CI);
      expect(selfCancelProblems(gone)).toEqual(['fail-fast: has 0 cancelling steps, needs exactly 1']);
    });
  });
});

// ── fail-fast.mjs ───────────────────────────────────────────────────────────

type J = { name: string; status: string; conclusion: string | null };
const done = (name: string, conclusion = 'success'): J => ({ name, status: 'completed', conclusion });
const running = (name: string): J => ({ name, status: 'in_progress', conclusion: null });
const [SUMMARY, DROP] = REPORTING_JOBS;
const ME = running(SELF_JOB);
/** Every job of a green run with the iOS shards, reporting jobs listed. */
const greenRun = (): J[] => [
  ME,
  done('Decide scope'), done('Unit tests'), done('Mobile typecheck'), done('Deploy tested preview'),
  done('E2E tests (against preview)'), done('iOS build (simulator app)'),
  done('iOS e2e · core'), done('iOS e2e · account'), done('iOS e2e · trips'),
  running(SUMMARY), { name: DROP, status: 'queued', conclusion: null },
];

describe('fail-fast.mjs decide: jobs → cancel | wait | done', () => {
  it('a failed job → cancel, naming it (a matrix shard by its expanded name)', () => {
    const jobs = [ME, done('Unit tests'), done('iOS e2e · account', 'failure'), running('iOS e2e · core')];
    expect(decide(jobs)).toEqual({ action: 'cancel', failed: ['iOS e2e · account'] });
  });

  it('a timed-out job is a failed job', () => {
    expect(decide([ME, done('E2E tests (against preview)', 'timed_out')])).toEqual({
      action: 'cancel', failed: ['E2E tests (against preview)'],
    });
  });

  it('every failed job is named, not just the first', () => {
    const jobs = [ME, done('Unit tests', 'failure'), done('Mobile typecheck', 'failure')];
    expect(decide(jobs)).toEqual({ action: 'cancel', failed: ['Unit tests', 'Mobile typecheck'] });
  });

  it('cancelled jobs and no failure → never cancel (a new push, or the matrix, did that)', () => {
    const jobs = [ME, done('Unit tests'), done('iOS e2e · core', 'cancelled'), running('iOS e2e · trips')];
    expect(decide(jobs)).toEqual({ action: 'wait' });
  });

  it('a failure in a reporting job, or in itself, is not a cause', () => {
    expect(decide([{ ...ME, status: 'completed', conclusion: 'failure' }, running('Unit tests')])).toEqual({ action: 'wait' });
    const jobs = greenRun().map((j) => (j.name === SUMMARY ? done(SUMMARY, 'failure') : j));
    expect(decide(jobs)).toEqual({ action: 'done' });
  });

  it('all green and the reporting jobs listed → done, without waiting on the reporting jobs', () => {
    expect(decide(greenRun())).toEqual({ action: 'done' });
  });

  it('all listed jobs green but the reporting jobs not listed yet → wait (later stages are still to come)', () => {
    const jobs = greenRun().filter((j) => !REPORTING_JOBS.includes(j.name));
    expect(decide(jobs)).toEqual({ action: 'wait' });
  });

  it('a docs-only run (reporting jobs skipped) is done', () => {
    const jobs = [ME, done('Decide scope'), done('Unit tests'), done('Deploy tested preview', 'skipped'),
      done(SUMMARY, 'skipped'), done(DROP, 'skipped')];
    expect(decide(jobs)).toEqual({ action: 'done' });
  });
});

/** A GitHub that returns each poll's jobs in turn and records every call. */
function fakeGitHub(polls: (J[] | { error: string } | { raw: string })[], cancelResult = { ok: true, stderr: '' }) {
  const calls: string[][] = [];
  const log: string[] = [];
  const summary: string[] = [];
  let t = 0;
  let i = 0;
  const io = {
    gh(args: string[]) {
      calls.push(args);
      if (args[0] === 'run') return { ok: cancelResult.ok, stdout: '', stderr: cancelResult.stderr };
      const p = polls[Math.min(i++, polls.length - 1)];
      if ('error' in p) return { ok: false, stdout: '', stderr: p.error };
      if ('raw' in p) return { ok: true, stdout: p.raw, stderr: '' };
      return { ok: true, stdout: p.map((j) => JSON.stringify(j)).join('\n') + '\n', stderr: '' };
    },
    sleep: (ms: number) => void (t += ms),
    now: () => t,
    log: (l: string) => void log.push(l),
    summary: (l: string) => void summary.push(l),
  };
  const cancelCalls = () => calls.filter((c) => c[0] === 'run');
  return { io, calls, log, summary, cancelCalls };
}
const watchWith = (io: ReturnType<typeof fakeGitHub>['io'], deadlineMs = 60 * 60_000) =>
  watch({ repo: 'samuelshirley/FeralTravels', runId: '36988769859', attempt: '1', io, deadlineMs });

describe('fail-fast.mjs watch: the loop against a stubbed GitHub', () => {
  it('polls this run attempt, then cancels ONCE when a job fails, naming it first', () => {
    const gh = fakeGitHub([
      [ME, running('Unit tests'), running('iOS e2e · account')],
      [ME, done('Unit tests'), done('iOS e2e · account', 'failure'), running('iOS e2e · core')],
    ]);
    expect(watchWith(gh.io)).toEqual({ action: 'cancel', failed: ['iOS e2e · account'] });
    expect(gh.calls[0]).toEqual([
      'api', '--paginate', 'repos/samuelshirley/FeralTravels/actions/runs/36988769859/attempts/1/jobs?per_page=100',
      '--jq', '.jobs[] | {name, status, conclusion} | tojson',
    ]);
    expect(gh.cancelCalls()).toEqual([['run', 'cancel', '36988769859', '-R', 'samuelshirley/FeralTravels']]);
    expect(gh.summary[0]).toBe('### ⛔ `iOS e2e · account` failed, so the rest of this run was cancelled');
    // The cancel is the last call: nothing is polled after it.
    expect(gh.calls.at(-1)?.[0]).toBe('run');
    expect(gh.log.join('\n')).not.toMatch(/::error::/);
  });

  it('only cancelled jobs, then all finished → no cancel', () => {
    const cancelledRun = greenRun().map((j) => (j.name === 'iOS e2e · core' ? done(j.name, 'cancelled') : j));
    const gh = fakeGitHub([[ME, done('Unit tests'), done('iOS e2e · core', 'cancelled')], cancelledRun]);
    expect(watchWith(gh.io)).toEqual({ action: 'done' });
    expect(gh.cancelCalls()).toEqual([]);
  });

  it('a failure only in a reporting job → no cancel', () => {
    const gh = fakeGitHub([greenRun().map((j) => (j.name === SUMMARY ? done(SUMMARY, 'failure') : j))]);
    expect(watchWith(gh.io)).toEqual({ action: 'done' });
    expect(gh.cancelCalls()).toEqual([]);
  });

  it('a green run → done without a cancel, after waiting for the later stages', () => {
    const early = [ME, done('Decide scope'), done('Unit tests')];
    const gh = fakeGitHub([early, early, greenRun()]);
    expect(watchWith(gh.io)).toEqual({ action: 'done' });
    expect(gh.calls).toHaveLength(3);
    expect(gh.cancelCalls()).toEqual([]);
  });

  it('an API error or unparseable output is a warning and another poll, then the failure still cancels', () => {
    const gh = fakeGitHub([
      { error: 'HTTP 502: Bad Gateway' },
      { raw: 'not json\n' },
      [ME, done('Unit tests', 'failure')],
    ]);
    expect(watchWith(gh.io)).toEqual({ action: 'cancel', failed: ['Unit tests'] });
    expect(gh.log.filter((l) => l.startsWith('::warning::'))).toHaveLength(2);
    expect(gh.cancelCalls()).toHaveLength(1);
  });

  it('a cancel that finds the run already over is a notice; any other cancel error a warning — never a throw', () => {
    const over = fakeGitHub([[ME, done('Unit tests', 'failure')]], { ok: false, stderr: 'Cannot cancel a workflow run that is completed' });
    expect(watchWith(over.io).action).toBe('cancel');
    expect(over.log.at(-1)).toMatch(/^::notice::gh run cancel: /);
    const denied = fakeGitHub([[ME, done('Unit tests', 'failure')]], { ok: false, stderr: 'HTTP 403: Resource not accessible' });
    expect(watchWith(denied.io).action).toBe('cancel');
    expect(denied.log.at(-1)).toMatch(/^::warning::Could not cancel/);
  });

  it('stops watching at its deadline without cancelling', () => {
    const gh = fakeGitHub([[ME, running('Unit tests')]]);
    expect(watchWith(gh.io, 60_000)).toEqual({ action: 'deadline' });
    expect(gh.calls.length).toBe(5); // t = 0, 15, 30, 45, 60 s
    expect(gh.cancelCalls()).toEqual([]);
  });
});

// ── The iOS PR comment, run for real ────────────────────────────────────────

/** ci.yml's `script: |` block for the comment step, dedented. */
function commentScript(): string {
  const lines = summaryComment().text.split('\n');
  const start = lines.findIndex((l) => l.trim() === 'script: |');
  const body: string[] = [];
  for (const l of lines.slice(start + 1)) {
    if (l.trim() !== '' && !l.startsWith(' '.repeat(12))) break;
    body.push(l.slice(12));
  }
  return body.join('\n');
}

/** Run the comment script against a stubbed run; return the comment it posts. */
async function postIosComment(jobs: J[], shardFiles: Record<string, object>, shards: string[]) {
  const posted: string[] = [];
  const files = Object.fromEntries(Object.entries(shardFiles).map(([s, r]) => [`ios-shard-${s}.json`, JSON.stringify(r)]));
  const fs = {
    existsSync: (p: string) => p === 'shards',
    readdirSync: () => Object.keys(files),
    readFileSync: (p: string) => files[p.replace(/^shards\//, '')],
  };
  const listJobs = () => undefined;
  const github = {
    paginate: async (fn: unknown) => {
      expect(fn).toBe(listJobs);
      return jobs;
    },
    rest: {
      actions: { listJobsForWorkflowRunAttempt: listJobs },
      issues: {
        listComments: async () => ({ data: [] }),
        deleteComment: async () => undefined,
        createComment: async ({ body }: { body: string }) => void posted.push(body),
      },
    },
  };
  const context = {
    serverUrl: 'https://github.com',
    repo: { owner: 'samuelshirley', repo: 'FeralTravels' },
    runId: 36988769859,
    payload: { pull_request: { number: 80, head: { sha: 'abcdef1234567' } } },
  };
  const proc = { env: { SHARDS: JSON.stringify(shards), RUN_ATTEMPT: '1' } };
  const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor;
  await new AsyncFunction('require', 'github', 'context', 'process', commentScript())(
    (m: string) => (m === 'fs' ? fs : undefined), github, context, proc,
  );
  expect(posted).toHaveLength(1);
  return posted[0];
}

const SHARDS = ['core', 'account', 'trips', 'ai'];
const shardRow = (comment: string, shard: string) => comment.split('\n').find((l) => l.startsWith(`| \`${shard}\` |`));

describe('the iOS comment on a stopped run (the run 36988769859 shape)', () => {
  /** Upstream green; `account` failed; matrix + watcher cancelled the rest; the summary is running. */
  const stoppedRun = (account: string): J[] => [
    done(SELF_JOB, 'cancelled'),
    done('Decide scope'), done('Unit tests'), done('Mobile typecheck'), done('Deploy tested preview'),
    done('E2E tests (against preview)'), done('iOS build (simulator app)'),
    done('iOS e2e · core', 'cancelled'), done('iOS e2e · account', account),
    done('iOS e2e · trips', 'cancelled'), done('iOS e2e · ai', 'cancelled'),
    running(SUMMARY), { name: DROP, status: 'queued', conclusion: null },
  ];
  const files = {
    account: { shard: 'account', outcome: 'failure', artifactUrl: 'https://example.test/rec' },
    core: { shard: 'core', outcome: 'skipped' },
    ai: { shard: 'ai', outcome: 'cancelled' },
    // trips: cancelled before it started — no file at all.
  };

  it('names the failed shard as the cause and labels the rest cancelled (stopped early)', async () => {
    const c = await postIosComment(stoppedRun('failure'), files, SHARDS);
    expect(c).toContain('**Stopped early: `iOS e2e · account` failed**');
    expect(c).toContain('Cancelled as a result: `iOS e2e · core`, `iOS e2e · trips`, `iOS e2e · ai`.');
    expect(shardRow(c, 'account')).toContain('❌ failure');
    for (const s of ['core', 'trips', 'ai']) expect(shardRow(c, s), s).toContain('⚪ cancelled (stopped early)');
    expect(c).not.toContain(SELF_JOB);
  });

  it('what a self-cancelling job produced: account `cancelled`, so no cause was named at all', async () => {
    // Why the per-job stop step went: this is the comment run 36988769859 got.
    const c = await postIosComment(stoppedRun('cancelled'), files, SHARDS);
    expect(c).not.toContain('Stopped early');
    expect(c).toContain('**Not green.**');
  });

  it('a green run whose watcher is still polling reads as passed', async () => {
    const green = stoppedRun('success').map((j) =>
      j.name.startsWith('iOS e2e · ') ? done(j.name) : j.name === SELF_JOB ? running(SELF_JOB) : j,
    );
    const ok = Object.fromEntries(SHARDS.map((s) => [s, { shard: s, outcome: 'success' }]));
    const c = await postIosComment(green, ok, SHARDS);
    expect(c).toContain('**Passed.**');
    expect(c).not.toContain('Stopped early');
  });
});

describe('the leaked-preview cleanup job', () => {
  const job = jobById('drop-preview-db');

  it('keeps its name, runs last and after a cancel, and never on a docs-only PR', () => {
    expect(job.fields.name).toBe('Drop the preview database if the PR has closed');
    expect(job.fields.needs).toBe('[decide, preview, e2e, ios-e2e]');
    expect(job.fields.if).toBe("always() && needs.decide.outputs.docs_only != 'true'");
  });

  it('can never turn CI red: every step continues on error and runs in a cancelled run', () => {
    for (const s of job.steps) {
      expect(s.fields['continue-on-error'], s.fields.name).toBe('true');
      expect(s.fields.if, s.fields.name).toMatch(/^always\(\)/);
    }
  });

  it("deletes only when the PR's LIVE state is not open, with pr-cleanup's action and inputs", () => {
    const [check, del] = job.steps;
    expect(check.text).toContain('gh pr view "$PR" -R "$GITHUB_REPOSITORY" --json state');
    expect(del.fields.if).toBe("always() && steps.pr.outputs.state != '' && steps.pr.outputs.state != 'OPEN'");
    expect(del.fields.uses).toBe('neondatabase/delete-branch-action@v3');
    expect(del.text).toContain('project_id: ${{ secrets.NEON_PROJECT_ID }}');
    expect(del.text).toContain('api_key: ${{ secrets.NEON_API_KEY }}');
    expect(del.text).toContain('branch: ${{ env.NEON_BRANCH }}');
    expect(CI).toContain('NEON_BRANCH: preview/pr-${{ github.event.pull_request.number }}');
  });
});

describe('job names other things depend on are unchanged', () => {
  it('branch protection and auto-merge read these', () => {
    expect(jobById('decide').fields.name).toBe('Decide scope');
    expect(jobById('unit').fields.name).toBe('Unit tests');
    expect(jobById('preview').fields.name).toBe('Deploy tested preview');
    expect(jobById('ios-e2e').fields.name).toBe('iOS e2e · ${{ matrix.shard }}');
    expect(jobById('ios-e2e-summary').fields.name).toBe('iOS e2e (simulator)');
  });
});
