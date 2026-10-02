import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * .github/scripts/auto-merge.mjs and the workflow that runs it: every open PR
 * into main merges itself (= deploys) once CI is green and the AI shard has
 * passed on its head; after every merge the other PRs get main merged in.
 * docs/design/auto-merge.md has the why.
 *
 * Merging is deploying and nobody looks first, so the rules are tested as a
 * table (state → action), the orchestration against a fake GitHub that records
 * every call, and the workflow file as text.
 */
// Plain ESM JS — same arrangement as decideDocsOnly.test.ts.
import * as autoMerge from '../../.github/scripts/auto-merge.mjs';

const {
  AI_JOB,
  CONFLICT_BODY,
  IOS_JOB_PREFIX,
  LABEL,
  MARKER,
  PREVIEW_JOB,
  aiHistory,
  classifyGhError,
  classifyRun,
  decideAfterCi,
  decideForOpenPr,
  isWriteCall,
  missingTests,
  normalisePr,
  run: runMain,
  testsMissingBody,
  tokenFor,
} = autoMerge;

const ROOT = path.resolve(__dirname, '../..');
const read = (p: string) => readFileSync(path.join(ROOT, p), 'utf8');

const REPO = 'samuelshirley/FeralTravels';
const HEAD = 'a'.repeat(40);
const MAIN = 'm'.repeat(40);
const ENV = { AUTO_UPDATE_TOKEN: 'pat', READ_TOKEN: 'gh-token', GITHUB_REPOSITORY: REPO };

type Job = { name: string; status?: string; conclusion: string | null };
const job = (name: string, conclusion: string | null = 'success'): Job => ({ name, status: 'completed', conclusion });

/** A green, non-docs CI run; `ai` adds the AI shard with that conclusion. */
function fullRun(ai?: string | null): Job[] {
  const jobs = [
    job('Decide scope'),
    job('Unit tests'),
    job(PREVIEW_JOB),
    job('E2E tests (against preview)'),
    job(`${IOS_JOB_PREFIX}account`),
    job(`${IOS_JOB_PREFIX}core`),
    job(`${IOS_JOB_PREFIX}trips`),
    job('iOS e2e (simulator)'),
  ];
  if (ai !== undefined) jobs.push(job(AI_JOB, ai));
  return jobs;
}
/** A docs-only run: everything that deploys or drives a device skipped. */
const docsRun = (): Job[] => [
  job('Decide scope'),
  job('Unit tests'),
  job(PREVIEW_JOB, 'skipped'),
  job('E2E tests (against preview)', 'skipped'),
  // A skipped matrix job is never expanded, so it keeps the template name.
  job('iOS e2e · ${{ matrix.shard }}', 'skipped'),
];

function restPr(over: Record<string, unknown> = {}) {
  return {
    number: 81,
    state: 'open',
    draft: false,
    base: { ref: 'main', repo: { full_name: REPO } },
    head: { sha: HEAD, repo: { full_name: REPO } },
    labels: [] as { name: string }[],
    mergeable_state: 'clean',
    mergeable: true,
    ...over,
  };
}

/** The state decideAfterCi sees for a PR that should merge. */
function state(over: Record<string, unknown> = {}) {
  return {
    run: { id: 200, headSha: HEAD, conclusion: 'success' },
    pr: normalisePr(restPr()),
    latestRunId: 200,
    jobs: fullRun('success'),
    ai: { passed: true, attempted: true },
    files: ['src/lib/units.ts', 'src/lib/units.test.ts'],
    mergeableState: 'clean',
    ...over,
  };
}
const withPr = (over: Record<string, unknown>) => normalisePr(restPr(over));

describe('decideAfterCi: state → action', () => {
  const cases: [string, Record<string, unknown>, string, RegExp?][] = [
    ['green, AI passed, up to date', {}, 'merge'],
    ['unstable (a non-required check pending) still merges', { mergeableState: 'unstable' }, 'merge'],
    ['has_hooks merges', { mergeableState: 'has_hooks' }, 'merge'],

    // Which PR, which run.
    ['no open PR has this head', { pr: null }, 'skip', /no open pull request/],
    ['stale head: the PR was pushed since this run', { pr: withPr({ head: { sha: 'b'.repeat(40), repo: { full_name: REPO } } }) }, 'skip', /stale run/],
    ['a re-run of an old run is not the latest for the sha', { latestRunId: 201 }, 'skip', /not the latest/],
    ['the PR was closed meanwhile', { pr: withPr({ state: 'closed' }) }, 'skip', /closed/],
    ['draft', { pr: withPr({ draft: true }) }, 'skip', /draft/],
    ['base is not main', { pr: withPr({ base: { ref: 'release', repo: { full_name: REPO } } }) }, 'skip', /not main/],
    ['fork PR', { pr: withPr({ head: { sha: HEAD, repo: { full_name: 'someone/FeralTravels' } } }) }, 'skip', /fork/],
    ['fork whose repo was deleted', { pr: withPr({ head: { sha: HEAD, repo: null } }) }, 'skip', /fork/],
    ['hold label', { pr: withPr({ labels: [{ name: 'hold' }] }) }, 'skip', /hold/],
    ['red run', { run: { id: 200, headSha: HEAD, conclusion: 'failure' } }, 'skip', /concluded failure/],
    // CI's fail-fast cancels the whole run when any job fails (2026-10-02).
    ['a run fail-fast stopped', { run: { id: 200, headSha: HEAD, conclusion: 'cancelled' }, jobs: fullRun('cancelled') }, 'skip', /concluded cancelled/],

    // The AI shard.
    ['green without the AI shard → label', { jobs: fullRun(), ai: { passed: false, attempted: false } }, 'label-ai'],
    ['AI shard already tried on this sha and red → never relabel', { jobs: fullRun('failure'), ai: { passed: false, attempted: true } }, 'skip', /already ran/],
    ['AI shard passed on an EARLIER run for the same sha → merge', { jobs: fullRun(), ai: { passed: true, attempted: true } }, 'merge'],
    ['docs-only merges without the AI shard', { jobs: docsRun(), ai: { passed: false, attempted: false }, files: ['docs/design/x.md'] }, 'merge'],
    ['jobs renamed out from under the script → stop, do not label', { jobs: [job('Decide scope'), job('Unit tests')], ai: { passed: false, attempted: false } }, 'skip', /renamed/],

    // Tests accompany app code.
    ['app code, no test → comment', { files: ['src/lib/units.ts'] }, 'comment-tests-missing'],
    ['app code, no test, `no-tests-needed` → merge', { files: ['src/lib/units.ts'], pr: withPr({ labels: [{ name: 'no-tests-needed' }] }) }, 'merge'],
    ['mobile code with a Maestro flow → merge', { files: ['mobile/app/index.tsx', 'mobile/maestro/x.yaml'] }, 'merge'],
    ['CI-only change needs no test', { files: ['.github/workflows/x.yml'] }, 'merge'],

    // Mergeability.
    ['behind main → update-branch', { mergeableState: 'behind' }, 'update-branch'],
    ['conflict → comment', { mergeableState: 'dirty' }, 'comment-conflict'],
    ['blocked → log only', { mergeableState: 'blocked' }, 'skip', /blocked/],
    ['still unknown after polling → log only', { mergeableState: 'unknown' }, 'skip', /unknown/],
  ];

  it.each(cases)('%s', (_name, over, action, reason) => {
    const d = decideAfterCi(state(over));
    expect(d.action).toBe(action);
    if (reason) expect(d.reason).toMatch(reason);
  });

  it('spends Penny last: behind, conflicted or test-less PRs are not sent to the AI shard', () => {
    const noAi = { jobs: fullRun(), ai: { passed: false, attempted: false } };
    expect(decideAfterCi(state({ ...noAi, mergeableState: 'behind' })).action).toBe('update-branch');
    expect(decideAfterCi(state({ ...noAi, mergeableState: 'dirty' })).action).toBe('comment-conflict');
    expect(decideAfterCi(state({ ...noAi, files: ['src/a.ts'] })).action).toBe('comment-tests-missing');
  });

  it('clears a sticky only once its condition is gone', () => {
    expect(decideAfterCi(state({ files: ['src/a.ts'] })).clear).toBeUndefined();
    expect(decideAfterCi(state({ mergeableState: 'dirty' })).clear).toEqual(['testsMissing']);
    expect(decideAfterCi(state()).clear).toEqual(['testsMissing', 'conflict']);
  });
});

describe('the pieces', () => {
  it('classifyRun', () => {
    expect(classifyRun(fullRun('success'))).toEqual({ docsOnly: false, known: true, aiPassed: true, aiAttempted: true });
    expect(classifyRun(fullRun())).toEqual({ docsOnly: false, known: true, aiPassed: false, aiAttempted: false });
    expect(classifyRun(fullRun('failure'))).toMatchObject({ aiPassed: false, aiAttempted: true });
    // Cancelled by a later label run: Penny's verdict never came, so it may be tried again.
    expect(classifyRun(fullRun('cancelled'))).toMatchObject({ aiPassed: false, aiAttempted: false });
    expect(classifyRun(docsRun())).toMatchObject({ docsOnly: true, known: true, aiPassed: false });
  });

  it('aiHistory looks across every run for the sha', () => {
    expect(aiHistory([fullRun(), fullRun('success')])).toEqual({ passed: true, attempted: true });
    expect(aiHistory([fullRun(), fullRun('failure')])).toEqual({ passed: false, attempted: true });
    expect(aiHistory([fullRun(), fullRun()])).toEqual({ passed: false, attempted: false });
    expect(aiHistory([fullRun(), fullRun('cancelled')])).toEqual({ passed: false, attempted: false });
  });

  it('missingTests', () => {
    expect(missingTests(['src/a.ts', 'mobile/b.tsx', 'README.md'], [])).toEqual(['src/a.ts', 'mobile/b.tsx']);
    expect(missingTests(['src/a.ts', 'src/components/A.test.tsx'], [])).toEqual([]);
    expect(missingTests(['src/a.ts', 'e2e/x.spec.ts'], [])).toEqual([]);
    expect(missingTests(['mobile/a.tsx', 'mobile/maestro/flow.yaml'], [])).toEqual([]);
    expect(missingTests(['src/a.ts'], [LABEL.noTests])).toEqual([]);
    expect(missingTests(['docs/x.md', 'src/lib/README.md', 'scripts/x.mjs'], [])).toEqual([]);
  });

  it('isWriteCall: only provable reads get github.token', () => {
    const reads = [
      ['api', 'repos/r/pulls/1'],
      ['api', '--paginate', 'repos/r/pulls/1/files', '--jq', '.[].filename'],
      ['api', '-X', 'GET', 'repos/r/x'],
      ['run', 'list', '--workflow', 'CI'],
      ['run', 'view', '1', '--json', 'jobs'],
      ['pr', 'view', '1'],
    ];
    const writes = [
      ['api', '-X', 'PUT', 'repos/r/pulls/1/update-branch', '-f', 'expected_head_sha=x'],
      ['api', '--method', 'DELETE', 'repos/r/issues/1/labels/ai-tests'],
      ['api', '--method=PATCH', 'repos/r/issues/comments/1'],
      ['api', 'repos/r/issues/1/comments', '-f', 'body=x'], // gh makes this a POST
      ['pr', 'merge', '1', '--merge'],
      ['pr', 'edit', '1', '--add-label', 'ai-tests'],
      ['label', 'create', 'hold'],
      ['run', 'rerun', '1'],
      ['something-new'],
    ];
    for (const a of reads) expect(isWriteCall(a), a.join(' ')).toBe(false);
    for (const a of writes) expect(isWriteCall(a), a.join(' ')).toBe(true);
    expect(tokenFor(writes[0], ENV)).toBe('pat');
    expect(tokenFor(reads[0], ENV)).toBe('gh-token');
  });

  it('classifyGhError', () => {
    expect(classifyGhError('gh: Bad credentials (HTTP 401)')).toBe('token-rejected');
    expect(classifyGhError('gh: Resource not accessible by personal access token (HTTP 403)')).toBe('token-rejected');
    expect(classifyGhError("gh: expected head sha didn't match current head ref. (HTTP 422)")).toBe('head-moved');
    expect(classifyGhError('gh: merge conflict between base and head (HTTP 422)')).toBe('conflict');
    expect(classifyGhError('gh: Server Error (HTTP 502)')).toBe('other');
  });

  it('decideForOpenPr', () => {
    const pr = normalisePr(restPr());
    expect(decideForOpenPr({ pr, behindBy: 2 }).action).toBe('update-branch');
    expect(decideForOpenPr({ pr, behindBy: 0 }).action).toBe('skip');
    for (const over of [{ draft: true }, { labels: [{ name: 'hold' }] }, { head: { sha: HEAD, repo: { full_name: 'x/y' } } }]) {
      expect(decideForOpenPr({ pr: withPr(over), behindBy: 3 }).action).toBe('skip');
    }
  });
});

// ── A fake GitHub ─────────────────────────────────────────────────────────────

type Comment = { id: number; body: string };
type Fake = {
  prs: ReturnType<typeof restPr>[];
  runs: { databaseId: number; status: string; conclusion: string }[];
  jobs: Record<number, Job[]>;
  files: string[];
  comments: Record<number, Comment[]>;
  behind: Record<string, number>;
  /** mergeable_state on successive reads of a PR (last one sticks) */
  mergeable?: string[];
  /** stderr for a failing write, keyed by a substring of the joined args */
  fail?: Record<string, string>;
  commitPulls?: number[];
};

function fakeGitHub(f: Fake) {
  const calls: { args: string[]; write: boolean }[] = [];
  const sleeps: number[] = [];
  const logs: string[] = [];
  let mergeableReads = 0;
  let nextId = 1000;
  const ok = (stdout: string) => ({ ok: true, stdout, stderr: '' });
  const pr = (n: number) => f.prs.find((p) => p.number === n)!;

  const io = {
    sleep: (ms: number) => void sleeps.push(ms),
    log: (l: string) => void logs.push(l),
    gh(args: string[]) {
      const joined = args.join(' ');
      // The fake's OWN idea of a write: the method/subcommand, by route.
      const m = joined.match(/(?:-X|--method) (\w+)/);
      const write = (m ? m[1] !== 'GET' : false) || (args[0] === 'pr' && args[1] === 'merge');
      calls.push({ args, write });
      for (const [needle, stderr] of Object.entries(f.fail ?? {})) {
        if (joined.includes(needle)) return { ok: false, stdout: '', stderr };
      }
      if (write) {
        const c = joined.match(/issues\/(\d+)\/comments -f body=([\s\S]*)$/);
        if (c) (f.comments[Number(c[1])] ??= []).push({ id: nextId++, body: c[2] });
        const e = joined.match(/issues\/comments\/(\d+) -f body=([\s\S]*)$/);
        if (e) for (const list of Object.values(f.comments)) for (const x of list) if (x.id === Number(e[1])) x.body = e[2];
        return ok('{}');
      }
      if (args[0] === 'run' && args[1] === 'list') return ok(JSON.stringify(f.runs));
      if (args[0] === 'run' && args[1] === 'view') return ok(JSON.stringify({ jobs: f.jobs[Number(args[2])] ?? [] }));
      let r: RegExpMatchArray | null;
      if ((r = joined.match(/repos\/[^/]+\/[^/]+\/pulls\/(\d+)\/files/))) return ok(f.files.join('\n'));
      if ((r = joined.match(/repos\/[^/]+\/[^/]+\/issues\/(\d+)\/comments/))) {
        const marked = (f.comments[Number(r[1])] ?? []).filter((x) => x.body.startsWith('<!-- auto-merge:'));
        return ok(marked.map((x) => JSON.stringify(x)).join('\n'));
      }
      if ((r = joined.match(/repos\/[^/]+\/[^/]+\/pulls\/(\d+)$/))) {
        const states = f.mergeable ?? [pr(Number(r[1])).mergeable_state];
        const s = states[Math.min(mergeableReads++, states.length - 1)];
        return ok(JSON.stringify({ ...pr(Number(r[1])), mergeable_state: s, mergeable: s !== 'dirty' }));
      }
      if (joined.includes('/commits/')) return ok((f.commitPulls ?? []).join('\n'));
      if (joined.includes('pulls?state=open')) return ok(f.prs.map((p) => JSON.stringify(p)).join('\n'));
      if ((r = joined.match(/compare\/\w+\.\.\.(\w+)/))) return ok(String(f.behind[r[1]] ?? 0));
      throw new Error(`fake GitHub has no route for: gh ${joined}`);
    },
  };
  const writes = () => calls.filter((c) => c.write).map((c) => c.args);
  return { io, calls, writes, sleeps, logs };
}

const ciEvent = (over: Record<string, unknown> = {}) => ({
  workflow_run: { id: 200, head_sha: HEAD, conclusion: 'success', event: 'pull_request', pull_requests: [{ number: 81 }], ...over },
});
const ciEnv = { ...ENV, GITHUB_EVENT_NAME: 'workflow_run' };
const pushEnv = { ...ENV, GITHUB_EVENT_NAME: 'push', GITHUB_SHA: MAIN };

function baseFake(over: Partial<Fake> = {}): Fake {
  return {
    prs: [restPr()],
    runs: [{ databaseId: 200, status: 'completed', conclusion: 'success' }],
    jobs: { 200: fullRun('success') },
    files: ['src/lib/units.ts', 'src/lib/units.test.ts'],
    comments: {},
    behind: {},
    ...over,
  };
}

/** Every call the fake saw as a write must go out with the PAT, never github.token. */
function expectWritesUsePat(calls: { args: string[]; write: boolean }[]) {
  for (const c of calls) {
    if (c.write) expect(tokenFor(c.args, ENV), c.args.join(' ')).toBe('pat');
  }
}

describe('onCiCompleted against a fake GitHub', () => {
  it('merges with a merge commit, pinned to the tested head', () => {
    const gh = fakeGitHub(baseFake());
    expect(runMain({ env: ciEnv, event: ciEvent(), io: gh.io })).toBe(0);
    const merges = gh.writes().filter((a) => a[0] === 'pr' && a[1] === 'merge');
    expect(merges).toHaveLength(1);
    expect(merges[0]).toEqual(['pr', 'merge', '81', '-R', REPO, '--merge', '--match-head-commit', HEAD]);
    for (const flag of ['--squash', '--rebase', '--auto', '--admin']) expect(merges[0]).not.toContain(flag);
    expectWritesUsePat(gh.calls);
  });

  it('green without the AI shard: re-applies the label (remove, then add) so `labeled` fires', () => {
    const gh = fakeGitHub(baseFake({ prs: [restPr({ labels: [{ name: 'ai-tests' }] })], jobs: { 200: fullRun() } }));
    runMain({ env: ciEnv, event: ciEvent(), io: gh.io });
    expect(gh.writes()).toEqual([
      ['api', '-X', 'DELETE', `repos/${REPO}/issues/81/labels/ai-tests`],
      ['api', '-X', 'POST', `repos/${REPO}/issues/81/labels`, '-f', 'labels[]=ai-tests'],
    ]);
    expectWritesUsePat(gh.calls);
  });

  it('label-loop guard: an earlier run on this sha already ran the AI shard red → no label', () => {
    const gh = fakeGitHub(
      baseFake({
        runs: [
          { databaseId: 201, status: 'completed', conclusion: 'success' },
          { databaseId: 200, status: 'completed', conclusion: 'failure' },
        ],
        jobs: { 201: fullRun(), 200: fullRun('failure') },
      }),
    );
    runMain({ env: ciEnv, event: ciEvent({ id: 201 }), io: gh.io });
    expect(gh.writes()).toEqual([]);
    expect(gh.logs.join('\n')).toMatch(/already ran/);
  });

  it('a stale run (PR pushed since) does nothing', () => {
    const gh = fakeGitHub(baseFake({ prs: [restPr({ head: { sha: 'b'.repeat(40), repo: { full_name: REPO } } })] }));
    runMain({ env: ciEnv, event: ciEvent(), io: gh.io });
    expect(gh.writes()).toEqual([]);
    expect(gh.logs.join('\n')).toMatch(/stale run/);
  });

  it('finds the PR from the commit when the payload lists none', () => {
    const gh = fakeGitHub(baseFake({ commitPulls: [81] }));
    runMain({ env: ciEnv, event: ciEvent({ pull_requests: [] }), io: gh.io });
    expect(gh.writes().some((a) => a[1] === 'merge')).toBe(true);
  });

  it('polls while mergeability is unknown, then acts', () => {
    const gh = fakeGitHub(baseFake({ mergeable: ['unknown', 'unknown', 'clean'] }));
    runMain({ env: ciEnv, event: ciEvent(), io: gh.io });
    expect(gh.sleeps.length).toBeGreaterThan(0);
    expect(gh.writes().some((a) => a[1] === 'merge')).toBe(true);
  });

  it('behind: update-branch with expected_head_sha', () => {
    const gh = fakeGitHub(baseFake({ mergeable: ['behind'] }));
    runMain({ env: ciEnv, event: ciEvent(), io: gh.io });
    expect(gh.writes()).toEqual([
      ['api', '-X', 'PUT', `repos/${REPO}/pulls/81/update-branch`, '-f', `expected_head_sha=${HEAD}`],
    ]);
  });

  it('tests missing: ONE sticky comment, updated in place, never duplicated', () => {
    const f = baseFake({ files: ['src/lib/units.ts'] });
    const first = fakeGitHub(f);
    runMain({ env: ciEnv, event: ciEvent(), io: first.io });
    expect(first.writes()).toHaveLength(1);
    expect(f.comments[81]).toHaveLength(1);
    expect(f.comments[81][0].body).toBe(testsMissingBody(['src/lib/units.ts']));
    expect(f.comments[81][0].body.startsWith(MARKER.testsMissing)).toBe(true);

    const again = fakeGitHub(f);
    runMain({ env: ciEnv, event: ciEvent(), io: again.io });
    expect(again.writes()).toEqual([]);

    f.files = ['src/lib/units.ts', 'src/lib/fuel.ts'];
    const changed = fakeGitHub(f);
    runMain({ env: ciEnv, event: ciEvent(), io: changed.io });
    expect(changed.writes()).toHaveLength(1);
    expect(changed.writes()[0].slice(0, 3)).toEqual(['api', '-X', 'PATCH']);
    expect(f.comments[81]).toHaveLength(1);
  });

  it('conflict: the comment is posted once', () => {
    const f = baseFake({ mergeable: ['dirty'] });
    runMain({ env: ciEnv, event: ciEvent(), io: fakeGitHub(f).io });
    runMain({ env: ciEnv, event: ciEvent(), io: fakeGitHub(f).io });
    expect(f.comments[81]).toEqual([{ id: expect.any(Number), body: CONFLICT_BODY }]);
  });

  it('removes a sticky once its condition is gone, then merges', () => {
    const f = baseFake({
      comments: { 81: [{ id: 7, body: `${MARKER.testsMissing}\nold` }, { id: 8, body: CONFLICT_BODY }, { id: 9, body: 'a human' }] },
    });
    const gh = fakeGitHub(f);
    runMain({ env: ciEnv, event: ciEvent(), io: gh.io });
    expect(gh.writes()).toContainEqual(['api', '-X', 'DELETE', `repos/${REPO}/issues/comments/7`]);
    expect(gh.writes()).toContainEqual(['api', '-X', 'DELETE', `repos/${REPO}/issues/comments/8`]);
    expect(gh.writes().some((a) => a.join(' ').includes('comments/9'))).toBe(false);
  });

  it('a rejected token fails the run loudly', () => {
    const gh = fakeGitHub(baseFake({ fail: { 'pr merge': 'GraphQL: Bad credentials (HTTP 401)' } }));
    expect(runMain({ env: ciEnv, event: ciEvent(), io: gh.io })).toBe(1);
    expect(gh.logs.join('\n')).toMatch(/::error::GitHub rejected AUTO_UPDATE_TOKEN/);
  });

  it('a merge that loses a race is a warning, not a failure', () => {
    const gh = fakeGitHub(baseFake({ fail: { 'pr merge': 'GraphQL: Base branch was modified. Review and try the merge again.' } }));
    expect(runMain({ env: ciEnv, event: ciEvent(), io: gh.io })).toBe(0);
    expect(gh.logs.join('\n')).toMatch(/::warning::.*merge refused/);
  });
});

describe('onMainPush against a fake GitHub', () => {
  const sha = (c: string) => c.repeat(40);
  const pr = (n: number, over: Record<string, unknown> = {}) =>
    restPr({ number: n, head: { sha: sha(String(n % 10)), repo: { full_name: REPO } }, ...over });

  it('merges main into every same-repo PR that is behind; skips the rest; one failure stops nothing', () => {
    const f = baseFake({
      prs: [
        pr(1), // behind → updated
        pr(2), // up to date
        pr(3, { draft: true }),
        pr(4, { labels: [{ name: 'hold' }] }),
        pr(5, { head: { sha: sha('5'), repo: { full_name: 'fork/FeralTravels' } } }),
        pr(6), // behind, conflicts
        pr(7), // behind, GitHub falls over
        pr(8), // behind → updated, after 7's failure
      ],
      behind: { [sha('1')]: 2, [sha('2')]: 0, [sha('6')]: 1, [sha('7')]: 1, [sha('8')]: 4 },
      fail: {
        'pulls/6/update-branch': 'gh: merge conflict between base and head (HTTP 422)',
        'pulls/7/update-branch': 'gh: Server Error (HTTP 502)',
      },
    });
    const gh = fakeGitHub(f);
    expect(runMain({ env: pushEnv, event: {}, io: gh.io })).toBe(0);

    const updates = gh.calls.filter((c) => c.args.join(' ').includes('update-branch')).map((c) => c.args);
    expect(updates).toEqual(
      [1, 6, 7, 8].map((n) => ['api', '-X', 'PUT', `repos/${REPO}/pulls/${n}/update-branch`, '-f', `expected_head_sha=${sha(String(n))}`]),
    );
    // No behind-check is even made for the PRs the bot must not touch.
    expect(gh.calls.some((c) => c.args.join(' ').includes(`compare/${MAIN}...${sha('5')}`))).toBe(false);
    expect(f.comments[6]?.map((c) => c.body)).toEqual([CONFLICT_BODY]);
    expect(gh.logs.some((l) => l.startsWith('::warning::PR #7'))).toBe(true);
    expectWritesUsePat(gh.calls);
  });

  it('posts the conflict comment once across merges', () => {
    const f = baseFake({
      prs: [pr(6)],
      behind: { [sha('6')]: 1 },
      fail: { 'pulls/6/update-branch': 'gh: merge conflict between base and head (HTTP 422)' },
    });
    runMain({ env: pushEnv, event: {}, io: fakeGitHub(f).io });
    runMain({ env: pushEnv, event: {}, io: fakeGitHub(f).io });
    expect(f.comments[6]).toHaveLength(1);
  });

  it('a head that moved under it is left to its own CI run', () => {
    const f = baseFake({
      prs: [pr(1)],
      behind: { [sha('1')]: 1 },
      fail: { 'pulls/1/update-branch': "gh: expected head sha didn't match current head ref. (HTTP 422)" },
    });
    const gh = fakeGitHub(f);
    expect(runMain({ env: pushEnv, event: {}, io: gh.io })).toBe(0);
    expect(f.comments[1]).toBeUndefined();
  });

  it('exits non-zero only when the token itself is rejected', () => {
    const f = baseFake({
      prs: [pr(1)],
      behind: { [sha('1')]: 1 },
      fail: { 'update-branch': 'gh: Bad credentials (HTTP 401)' },
    });
    expect(runMain({ env: pushEnv, event: {}, io: fakeGitHub(f).io })).toBe(1);
  });
});

describe('without the token', () => {
  it('logs a notice, touches nothing, exits 0', () => {
    for (const env of [ciEnv, pushEnv]) {
      const gh = fakeGitHub(baseFake());
      expect(runMain({ env: { ...env, AUTO_UPDATE_TOKEN: '' }, event: ciEvent(), io: gh.io })).toBe(0);
      expect(gh.calls).toEqual([]);
      expect(gh.logs).toEqual([expect.stringMatching(/^::notice::AUTO_UPDATE_TOKEN is not set/)]);
    }
  });
});

describe('.github/workflows/auto-merge.yml', () => {
  const wf = read('.github/workflows/auto-merge.yml');
  const ci = read('.github/workflows/ci.yml');
  const code = (s: string) => s.split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n');
  const body = code(wf);

  it('fires when CI completes and on every push to main', () => {
    expect(body).toMatch(/^on:\n {2}workflow_run:\n {4}workflows: \[CI\]\n {4}types: \[completed\]\n {2}push:\n {4}branches: \[main\]\n/m);
    // `workflows: [CI]` names ci.yml by its `name:`; a rename silently stops auto-merge.
    expect(ci).toMatch(/^name: CI$/m);
  });

  it('runs one at a time per PR head, never cancelling one mid-merge', () => {
    expect(body).toMatch(
      /^concurrency:\n {2}group: auto-merge-\$\{\{ github\.event\.workflow_run\.head_sha \|\| 'main' \}\}\n {2}cancel-in-progress: false$/m,
    );
  });

  it('writes only with secrets.AUTO_UPDATE_TOKEN; github.token is read-only', () => {
    expect(body).toMatch(/^permissions:\n {2}contents: read\n {2}actions: read\n {2}pull-requests: read\n\n/m);
    expect(body).not.toMatch(/: write/);
    const steps = body.split('\n      - ').filter((s) => s.includes('.github/scripts/auto-merge.mjs'));
    expect(steps).toHaveLength(2);
    for (const s of steps) {
      expect(s).toContain('AUTO_UPDATE_TOKEN: ${{ secrets.AUTO_UPDATE_TOKEN }}');
      expect(s).toContain('READ_TOKEN: ${{ github.token }}');
    }
    // gh reads GH_TOKEN/GITHUB_TOKEN from the environment; the script sets it per call.
    expect(body).not.toMatch(/GH_TOKEN|GITHUB_TOKEN/);
    expect(body.match(/github\.token/g)).toHaveLength(2);
  });

  it('never checks out PR code', () => {
    expect(body).not.toMatch(/ref:/);
    expect(body.match(/persist-credentials: false/g)).toHaveLength(2);
  });

  it("the job names the script reads are ci.yml's", () => {
    expect(ci).toContain(`name: ${PREVIEW_JOB}\n`);
    expect(ci).toContain(`name: ${IOS_JOB_PREFIX}\${{ matrix.shard }}\n`);
    expect(existsSync(path.join(ROOT, 'mobile/maestro/shards/ai.yaml'))).toBe(true);
    expect(ci).toContain(`[ "$LABEL_NAME" = "${LABEL.ai}" ]`);
  });
});
