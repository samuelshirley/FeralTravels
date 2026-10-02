import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * CI fails fast (Sam, 2026-10-02): "If anything fails on the PR, immediately
 * stop the rest of the jobs and investigate the failure so we aren't wasting
 * time or tokens."
 *
 * ci.yml did the opposite on purpose until then — `fail-fast: false` on the
 * iOS matrix and nothing stopping the run — so a red Unit tests left the macOS
 * shards and the Penny-spending `ai` shard running on a PR that was already
 * red. Now every job that does real work ends with a `Stop the whole run` step
 * (`gh run cancel` on its own run), LAST so the steps that report the failure
 * run first. The jobs that run after a cancel by design are an explicit list
 * here: a job added later without the step fails this file.
 *
 * There is no YAML parser in the dependency tree, and ci.yml's layout is
 * regular (2-space indent, steps at 6), so `parseWorkflow` reads just the
 * structure these checks need. The first test proves it found the jobs, so a
 * layout change fails loudly instead of passing on nothing.
 */

const ROOT = path.resolve(__dirname, '../..');
const CI = readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');

/** Run after a cancel by design (`if: always()`), so they carry no stop step. */
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

const isStopStep = (s: Step) => /gh run cancel/.test(s.text);

/** Every way a workflow breaks the fail-fast rule, one line each; [] when it keeps it. */
function failFastProblems(src: string): string[] {
  const { jobs } = parseWorkflow(src);
  const problems: string[] = [];
  for (const job of jobs) {
    const stops = job.steps.filter(isStopStep);
    if (AFTER_CANCEL_JOBS.includes(job.id)) {
      if (stops.length > 0) problems.push(`${job.id}: runs after a cancel, but has a stop step`);
      continue;
    }
    const last = job.steps.at(-1);
    if (stops.length !== 1) {
      problems.push(`${job.id}: has ${stops.length} \`Stop the whole run\` steps, needs exactly 1`);
      continue;
    }
    const stop = stops[0];
    if (stop !== last) problems.push(`${job.id}: the stop step is not the job's last step`);
    if (!/^failure\(\)/.test(stop.fields.if ?? '')) {
      problems.push(`${job.id}: the stop step's if is "${stop.fields.if}", not failure()`);
    }
    if (!stop.text.includes('gh run cancel ${{ github.run_id }} -R ${{ github.repository }}')) {
      problems.push(`${job.id}: the stop step does not cancel github.run_id`);
    }
    if (stop.env.GH_TOKEN !== '${{ github.token }}') problems.push(`${job.id}: the stop step has no GH_TOKEN`);
    if (stop.env.FAILED_JOB !== job.fields.name) {
      problems.push(`${job.id}: FAILED_JOB is "${stop.env.FAILED_JOB}", the job is named "${job.fields.name}"`);
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

describe('ci.yml fails fast', () => {
  it('the parser sees every job (so the checks below are not passing on nothing)', () => {
    expect(wf.jobs.map((j) => j.id)).toEqual([
      'decide', 'unit', 'mobile', 'preview', 'e2e', 'ios-build', 'ios-e2e', 'ios-e2e-summary', 'drop-preview-db',
    ]);
    for (const j of wf.jobs) expect(j.steps.length, j.id).toBeGreaterThan(0);
  });

  it('(a) the iOS matrix is fail-fast: a red shard cancels the others', () => {
    expect(jobById('ios-e2e').failFast).toBe('true');
  });

  it('(b, c, e) every job except the after-cancel ones ends with an if: failure() step cancelling this run', () => {
    expect(failFastProblems(CI)).toEqual([]);
  });

  it('(d) the token may cancel the run, and nothing else was widened or dropped', () => {
    expect(wf.permissions).toEqual({ contents: 'read', 'pull-requests': 'write', actions: 'write' });
  });

  it('a new push still cancels the run in flight (the concurrency group is untouched)', () => {
    expect(CI).toMatch(/^concurrency:\n {2}group: ci-pr-\$\{\{ github\.event\.pull_request\.number \}\}\n {2}cancel-in-progress: true$/m);
  });

  it('the after-cancel list names real jobs, and each runs after a cancel', () => {
    for (const id of AFTER_CANCEL_JOBS) {
      expect(jobById(id).fields.if, id).toMatch(/^always\(\) && /);
    }
  });

  it('the iOS summary still writes its comment in a cancelled run', () => {
    // A step's default condition is success(), which is false once the run is
    // cancelled: without always() the comment would silently not be written.
    const summary = jobById('ios-e2e-summary');
    const download = summary.steps.find((s) => s.fields.uses?.startsWith('actions/download-artifact'));
    const comment = summary.steps.find((s) => s.fields.name === 'Comment iOS results on the PR');
    expect(download?.fields.if).toBe('always()');
    expect(comment?.fields.if).toBe("always() && github.event_name == 'pull_request'");
    // ...and says what stopped the run instead of calling cancelled shards failures.
    expect(comment?.text).toContain('listJobsForWorkflowRunAttempt');
    expect(comment?.text).toContain('Stopped early: ${names(failed)} failed');
    expect(comment?.text).toContain('Cancelled as a result: ${names(cancelled)}');
    expect(comment?.text).toContain("'cancelled (stopped early)'");
    // Its own name list must match the jobs that really run after a cancel.
    for (const id of AFTER_CANCEL_JOBS) expect(comment?.text).toContain(`'${jobById(id).fields.name}'`);
  });

  it("the reporting steps run before the stop step, so the first failure keeps its evidence", () => {
    // True by (c) — the stop step is last — stated for the steps that matter.
    const e2e = jobById('e2e').steps.map((s) => s.fields.name);
    const shard = jobById('ios-e2e').steps.map((s) => s.fields.name ?? s.fields.uses);
    expect(e2e.indexOf('Comment E2E results on the PR')).toBe(e2e.length - 2);
    expect(shard.indexOf('Say where the flow died')).toBeLessThan(shard.indexOf('Stop the whole run'));
    expect(shard.indexOf('Upload the recordings')).toBeLessThan(shard.indexOf('Stop the whole run'));
  });

  describe('the check itself catches', () => {
    it('a job added later without the stop step', () => {
      const added = `${CI}\n  later:\n    name: A later job\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n`;
      expect(failFastProblems(added)).toEqual(['later: has 0 `Stop the whole run` steps, needs exactly 1']);
    });

    it('a stop step that is not last', () => {
      const moved = CI.replace('\n  ios-e2e:\n', '      - run: echo after\n\n  ios-e2e:\n');
      expect(moved).not.toBe(CI);
      expect(failFastProblems(moved)).toEqual(["ios-build: the stop step is not the job's last step"]);
    });
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
