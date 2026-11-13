import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
// Plain ESM JS, imported directly (as ciFailFast.test.ts does fail-fast.mjs).
import * as waiter from '../../.github/scripts/wait-for-ios-bundle.mjs';

/**
 * The iOS shards start before the preview and wait for its JavaScript inside
 * the job (2026-11-12). Two things must hold for that to be safe as well as
 * fast, and this file holds both:
 *
 *  1. A shard never installs a bundle built for ANOTHER preview. On a re-run,
 *     GitHub carries the jobs it does not re-run into the new attempt with
 *     `run_attempt` rewritten and their original `started_at` (read off runs
 *     42382766969 and 42387577080, not assumed) — so the waiter picks the
 *     artifact created inside the listed bundle job's own time window.
 *  2. ci.yml is wired the way the waiter assumes: the job name and artifact
 *     prefix agree, the shard takes its URL from the bundle (never from the
 *     preview's output, which it no longer waits for), and the job budget is
 *     the wait's cap plus the old 60 minutes.
 */

const { BUNDLE_JOB, ARTIFACT_PREFIX, decide, wait } = waiter;

const ROOT = path.resolve(__dirname, '../..');
const CI = readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');

/** One top-level job's text, up to the next job. */
function jobText(id: string): string {
  const start = CI.indexOf(`\n  ${id}:\n`);
  if (start === -1) throw new Error(`ci.yml has no job ${id}`);
  const next = CI.slice(start + 1).search(/\n {2}[a-z0-9_-]+:\n/);
  return CI.slice(start, next === -1 ? undefined : start + 1 + next);
}

/** One step's text inside a job, by its `name:`. */
function stepText(job: string, name: string): string {
  const start = job.indexOf(`      - name: ${name}\n`);
  if (start === -1) throw new Error(`no step "${name}"`);
  const next = job.slice(start + 1).search(/\n {6}- /);
  return job.slice(start, next === -1 ? undefined : start + 1 + next);
}

const bundleJob = (over: Record<string, unknown> = {}) => ({
  name: BUNDLE_JOB,
  status: 'completed',
  conclusion: 'success',
  started_at: '2026-11-12T14:00:00Z',
  completed_at: '2026-11-12T14:01:30Z',
  ...over,
});
const artifact = (name: string, created_at: string, id = 1) => ({ id, name, created_at, expired: false });

describe('decide: which bundle a shard may use', () => {
  it('waits while the bundle job is not listed (it is still waiting on the preview)', () => {
    expect(decide([{ name: 'Unit tests', status: 'completed', conclusion: 'success' }], []).action).toBe('wait');
  });

  it('waits while it runs', () => {
    expect(decide([bundleJob({ status: 'in_progress', conclusion: null, completed_at: null })], []).action).toBe('wait');
  });

  it.each(['failure', 'skipped', 'cancelled', 'timed_out'])('fails at once when it concluded %s, naming it', (c) => {
    const d = decide([bundleJob({ conclusion: c })], [artifact('ios-bundle-1', '2026-11-12T14:01:00Z')]);
    expect(d.action).toBe('fail');
    expect(d.action === 'fail' && d.why).toContain(BUNDLE_JOB);
  });

  it('takes the artifact the listed job made', () => {
    const d = decide([bundleJob()], [artifact('ios-bundle-1', '2026-11-12T14:01:10Z', 7)]);
    expect(d).toEqual({ action: 'ready', artifact: expect.objectContaining({ id: 7 }) });
  });

  it('RE-RUN: refuses the previous attempt\'s bundle, which is for a dead preview', () => {
    // Attempt 1 bundled for preview A at 14:01; attempt 2 re-ran everything and
    // its bundle job (for preview B) started at 14:30. The old artifact exists
    // and its name still matches the prefix; it must not be taken.
    const jobs = [bundleJob({ started_at: '2026-11-12T14:30:00Z', completed_at: '2026-11-12T14:31:40Z' })];
    const stale = artifact('ios-bundle-1', '2026-11-12T14:01:10Z', 1);
    expect(decide(jobs, [stale]).action).toBe('no-artifact');
    const fresh = artifact('ios-bundle-2', '2026-11-12T14:31:20Z', 2);
    expect(decide(jobs, [stale, fresh])).toEqual({ action: 'ready', artifact: fresh });
  });

  it('RE-RUN FAILED JOBS: a carried bundle job keeps its own artifact', () => {
    // Carried into attempt 2 with its ORIGINAL times (runs 42382766969,
    // 42387577080), so the attempt-1 artifact is in its window — correctly:
    // the preview it was built for was carried too.
    const carried = bundleJob({ started_at: '2026-11-12T14:00:00Z', completed_at: '2026-11-12T14:01:30Z' });
    const d = decide([carried], [artifact('ios-bundle-1', '2026-11-12T14:01:10Z', 1)]);
    expect(d.action).toBe('ready');
  });

  it('ignores expired artifacts and other names', () => {
    const d = decide([bundleJob()], [
      { ...artifact('ios-bundle-1', '2026-11-12T14:01:10Z', 1), expired: true },
      artifact('ios-sim-app', '2026-11-12T14:01:00Z', 2),
    ]);
    expect(d.action).toBe('no-artifact');
  });
});

describe('wait: the polling loop against a stubbed GitHub', () => {
  const jobsLine = (j: object) => JSON.stringify(j);
  function stubIo(responses: Array<{ jobs: object[]; artifacts: object[] } | 'error'>) {
    let t = 0;
    let i = 0;
    const logs: string[] = [];
    let current: (typeof responses)[number] = responses[0];
    return {
      logs,
      io: {
        gh(args: string[]) {
          const isJobs = args.some((a) => a.includes('/jobs'));
          if (isJobs) current = responses[Math.min(i++, responses.length - 1)];
          if (current === 'error') return { ok: false, stdout: '', stderr: 'HTTP 502' };
          const rows = isJobs ? current.jobs : current.artifacts;
          return { ok: true, stdout: rows.map(jobsLine).join('\n'), stderr: '' };
        },
        sleep(ms: number) {
          t += ms;
        },
        now: () => t,
        log: (l: string) => logs.push(l),
      },
    };
  }

  it('polls through a pending job and an API error, then returns the artifact', () => {
    const { io } = stubIo([
      { jobs: [], artifacts: [] },
      'error',
      { jobs: [bundleJob({ status: 'in_progress', conclusion: null, completed_at: null })], artifacts: [] },
      { jobs: [bundleJob()], artifacts: [artifact('ios-bundle-1', '2026-11-12T14:01:10Z', 9)] },
    ]);
    const r = wait({ repo: 'o/r', runId: '1', attempt: '1', io, pollMs: 10_000, deadlineMs: 60 * 60_000 });
    expect(r).toEqual({ ok: true, artifact: expect.objectContaining({ id: 9 }) });
  });

  it('gives a green job without an artifact a grace period, then fails', () => {
    const { io } = stubIo([{ jobs: [bundleJob()], artifacts: [] }]);
    const r = wait({ repo: 'o/r', runId: '1', attempt: '1', io, pollMs: 10_000, deadlineMs: 60 * 60_000, graceMs: 30_000 });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.why).toMatch(/no ios-bundle-\* artifact/);
  });

  it('stops at the deadline with the last reason', () => {
    const { io } = stubIo([{ jobs: [], artifacts: [] }]);
    const r = wait({ repo: 'o/r', runId: '1', attempt: '1', io, pollMs: 10_000, deadlineMs: 60_000 });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.why).toMatch(/no bundle after 1 min .*not listed yet/);
  });

  it('reads THIS attempt\'s jobs, not the run\'s latest', () => {
    const seen: string[][] = [];
    const { io } = stubIo([{ jobs: [bundleJob({ conclusion: 'failure' })], artifacts: [] }]);
    const gh = io.gh;
    io.gh = (args: string[]) => (seen.push(args), gh(args));
    wait({ repo: 'o/r', runId: '42', attempt: '3', io, deadlineMs: 60_000 });
    expect(seen.some((a) => a.includes('repos/o/r/actions/runs/42/attempts/3/jobs?per_page=100'))).toBe(true);
  });
});

describe('ci.yml is wired the way the waiter assumes', () => {
  const bundle = jobText('ios-bundle');
  const shard = jobText('ios-e2e');

  it("the bundle job's name and artifact are the waiter's", () => {
    expect(bundle).toContain(`\n    name: ${BUNDLE_JOB}\n`);
    expect(bundle).toContain(`name: ${ARTIFACT_PREFIX}\${{ github.run_attempt }}`);
    expect(bundle).toContain('scripts/ios-rebundle.sh bundle ios-bundle "$API_URL"');
    expect(bundle).toContain('API_URL: ${{ needs.preview.outputs.url }}');
  });

  it('the shard takes its preview from the bundle, never from the preview job', () => {
    // It no longer needs `preview`, so `needs.preview.outputs.url` would be
    // EMPTY here — and an empty base URL fails as something else entirely.
    expect(shard).not.toContain('needs.preview');
    expect(shard).toContain('PREVIEW_URL="$(cat ios-bundle/api-url)"');
    expect(shard).toContain('--base-url "$PREVIEW_URL"');
    expect(shard).toContain('E2E_BASE_URL: ${{ env.PREVIEW_URL }}');
  });

  it('the shard downloads the artifact the waiter chose, by id', () => {
    expect(stepText(shard, "Wait for this preview's bundle")).toContain('node .github/scripts/wait-for-ios-bundle.mjs');
    expect(stepText(shard, "Download this preview's bundle")).toContain('ARTIFACT_ID: ${{ steps.bundle.outputs.artifact_id }}');
    expect(shard).toContain('scripts/ios-rebundle.sh apply ios-bundle ios-app/*.app');
  });

  it('setup happens before the wait, and the bundle before the install', () => {
    const at = (s: string) => {
      const i = shard.indexOf(s);
      expect(i, s).toBeGreaterThan(-1);
      return i;
    };
    const wait = at("- name: Wait for this preview's bundle");
    for (const early of ['- name: Start booting a simulator', '- name: Restore or install Maestro', 'name: ios-sim-app']) {
      expect(at(early), early).toBeLessThan(wait);
    }
    expect(wait).toBeLessThan(at("- name: Put this preview's JavaScript into the app"));
    expect(at("- name: Put this preview's JavaScript into the app")).toBeLessThan(at('- name: Wait for the simulator and install the app'));
  });

  it('the shard installs no node_modules (the time this saves is the point)', () => {
    // Commands and keys only — the comments explain why there is none.
    const code = shard.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    expect(code).not.toMatch(/\bnpm (ci|install)\b/);
    expect(code).not.toMatch(/cache: npm/);
  });

  it("the job's budget is the wait's cap plus the old 60, and the waiter stops before its step", () => {
    const step = stepText(shard, "Wait for this preview's bundle");
    const stepCap = Number(/\n {8}timeout-minutes: (\d+)\n/.exec(step)?.[1]);
    const deadline = Number(/IOS_BUNDLE_DEADLINE_MINUTES: '(\d+)'/.exec(step)?.[1]);
    const job = Number(/\n {4}timeout-minutes: (\d+)\n/.exec(shard)?.[1]);
    expect(stepCap).toBeGreaterThan(0);
    expect(deadline).toBeLessThan(stepCap);
    expect(job).toBeGreaterThanOrEqual(stepCap + 60);
  });
});
