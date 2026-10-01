#!/usr/bin/env node
/**
 * Auto-merge: continuous deployment for every open PR into `main`.
 *
 * Run by `.github/workflows/auto-merge.yml` in two modes, picked from
 * GITHUB_EVENT_NAME:
 *
 *  - `workflow_run` (a CI run completed) → `onCiCompleted`: decide what the
 *    tested PR needs next — start the AI run (`ai-tests` label), bring it up to
 *    date with main, merge it, or say on the PR why it is stuck.
 *  - `push` to main (any merge) → `onMainPush`: bring every other open PR up to
 *    date by merging main INTO it (GitHub's update-branch), never a rebase.
 *
 * The why — what merges when, the labels, the token, the cost — is in
 * docs/design/auto-merge.md. Read it before changing a rule here.
 *
 * ── Shape ──────────────────────────────────────────────────────────────────
 *
 * Every rule is a pure function (`guardPr`, `classifyRun`, `missingTests`,
 * `decideAfterCi`, `decideForOpenPr`, …) and is table-tested in
 * src/lib/autoMerge.test.ts. The orchestrators take an `io` whose `gh(args)` is
 * the only way out of the process, so the tests stub GitHub entirely.
 *
 * ── Two tokens, chosen by the command, not by the caller ──────────────────
 *
 * A push, label or merge made with the workflow's own GITHUB_TOKEN starts no
 * workflows: CI would never run on an updated branch and production would never
 * deploy a bot merge. So every WRITE goes out with AUTO_UPDATE_TOKEN (Sam's
 * fine-grained PAT). Reads use READ_TOKEN (`github.token`, which has
 * `actions: read` — the PAT does not). `tokenFor` derives which from the gh
 * arguments themselves, and anything it cannot prove is a read is a write.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** The workflow name in ci.yml (`name: CI`) — the workflow_run trigger's target. */
export const CI_WORKFLOW = 'CI';
/** Skipped exactly when ci.yml's decide job called the diff docs-only. */
export const PREVIEW_JOB = 'Deploy tested preview';
/** ci.yml's matrix job is `iOS e2e · ${{ matrix.shard }}`. */
export const IOS_JOB_PREFIX = 'iOS e2e · ';
/** The shard of Maestro flows that ask Penny to plan for real (Anthropic spend). */
export const AI_JOB = `${IOS_JOB_PREFIX}ai`;

export const LABEL = {
  ai: 'ai-tests',
  hold: 'hold',
  noTests: 'no-tests-needed',
};

/** Hidden first line of each sticky comment; a comment is found by its marker. */
export const MARKER = {
  testsMissing: '<!-- auto-merge:tests-missing -->',
  conflict: '<!-- auto-merge:conflict -->',
};

/** mergeable_state values GitHub will merge on. */
const MERGEABLE = new Set(['clean', 'unstable', 'has_hooks']);

const short = (sha) => String(sha ?? '').slice(0, 7);

// ── Tokens ──────────────────────────────────────────────────────────────────

const BODY_FLAGS = new Set(['-f', '-F', '--field', '--raw-field', '--input']);

/**
 * Does this gh invocation change anything on GitHub?
 *
 * Unknown commands answer true: the failure that matters is a write going out
 * with github.token (it succeeds, and silently starts no workflow), so doubt
 * resolves to the PAT.
 *
 * @param {string[]} args
 */
export function isWriteCall(args) {
  const [cmd, sub] = args;
  if (cmd === 'api') {
    let method = null;
    let hasBody = false;
    for (let i = 1; i < args.length; i++) {
      const a = args[i];
      if (a === '-X' || a === '--method') method = String(args[i + 1] ?? '').toUpperCase();
      else if (a.startsWith('--method=')) method = a.slice('--method='.length).toUpperCase();
      else if (BODY_FLAGS.has(a)) hasBody = true;
    }
    // gh api turns a request with fields into a POST unless told otherwise.
    return (method ?? (hasBody ? 'POST' : 'GET')) !== 'GET';
  }
  if (cmd === 'run') return !['list', 'view'].includes(sub);
  if (cmd === 'pr') return !['list', 'view', 'diff', 'checks'].includes(sub);
  return true;
}

/**
 * @param {string[]} args
 * @param {Record<string, string | undefined>} env
 */
export function tokenFor(args, env) {
  if (isWriteCall(args)) return env.AUTO_UPDATE_TOKEN ?? '';
  return env.READ_TOKEN || env.AUTO_UPDATE_TOKEN || '';
}

/**
 * What a failed gh call means for the caller.
 * @param {string} stderr
 * @returns {'token-rejected' | 'head-moved' | 'conflict' | 'other'}
 */
export function classifyGhError(stderr) {
  if (/HTTP 401|Bad credentials|Resource not accessible by personal access token/i.test(stderr)) {
    return 'token-rejected';
  }
  // update-branch: "expected head sha didn't match current head ref"
  if (/expected.head.sha/i.test(stderr)) return 'head-moved';
  // update-branch: "merge conflict between base and head"
  if (/conflict/i.test(stderr)) return 'conflict';
  return 'other';
}

export class GhError extends Error {
  /** @param {string[]} args @param {string} stderr */
  constructor(args, stderr) {
    super(`gh ${args.join(' ')} failed: ${stderr.trim()}`);
    this.kind = classifyGhError(stderr);
    this.write = isWriteCall(args);
  }
}

// ── Pure rules ──────────────────────────────────────────────────────────────

/**
 * The fields the rules read, from a REST pull request.
 * @param {any} p
 */
export function normalisePr(p) {
  return {
    number: p.number,
    state: p.state,
    draft: Boolean(p.draft),
    baseRef: p.base?.ref,
    baseRepo: p.base?.repo?.full_name ?? null,
    // A fork whose repository was deleted has no head repo: treat it as a fork.
    headRepo: p.head?.repo?.full_name ?? null,
    headSha: p.head?.sha,
    labels: (p.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name)),
    mergeableState: p.mergeable_state ?? 'unknown',
    mergeable: p.mergeable ?? null,
  };
}

/**
 * Why this PR is not the bot's to touch at all, or null. Shared by both modes.
 * @param {ReturnType<typeof normalisePr>} pr
 */
export function prSkipReason(pr) {
  if (pr.state !== 'open') return `PR #${pr.number} is ${pr.state}`;
  if (pr.draft) return `PR #${pr.number} is a draft`;
  if (pr.baseRef !== 'main') return `PR #${pr.number} targets ${pr.baseRef}, not main`;
  // The PAT can write to this repo; a fork's code must never be what it merges
  // or updates on the fork author's behalf.
  if (!pr.headRepo || pr.headRepo !== pr.baseRepo) return `PR #${pr.number} comes from a fork`;
  if (pr.labels.includes(LABEL.hold)) return `PR #${pr.number} has the \`${LABEL.hold}\` label`;
  return null;
}

/**
 * Why a completed CI run must not move its PR, or null.
 *
 * @param {{
 *   run: { id: number, headSha: string, conclusion: string },
 *   pr: ReturnType<typeof normalisePr> | null,
 *   latestRunId: number | undefined,
 * }} s
 */
export function guardPr({ run, pr, latestRunId }) {
  if (!pr) return `no open pull request has head ${short(run.headSha)}`;
  const skip = prSkipReason(pr);
  if (skip) return skip;
  // The PR was pushed after this run started: its own run will decide.
  if (pr.headSha !== run.headSha) {
    return `stale run: PR #${pr.number}'s head is ${short(pr.headSha)}, this run tested ${short(run.headSha)}`;
  }
  // A re-run of an old run, or one superseded by a later run on the same sha
  // (a label run). The deploy gate reads only the latest, so this does too.
  if (latestRunId !== run.id) {
    return `run ${run.id} is not the latest CI run for ${short(run.headSha)} (latest: ${latestRunId ?? 'none'})`;
  }
  if (run.conclusion !== 'success') return `CI concluded ${run.conclusion}`;
  return null;
}

/**
 * What one CI run's jobs say.
 *
 * `known` is false when the run is neither recognisably docs-only nor shows an
 * iOS shard that ran — a CI job renamed out from under these constants. That
 * case stops rather than relabels: if `iOS e2e · ai` were renamed, every label
 * run would look like it never ran the AI shard, and relabelling would loop.
 *
 * A CANCELLED AI job is not an attempt. Any label, or a reopen, starts a new
 * CI run that cancels the one in flight (ci.yml's concurrency), so adding
 * `hold` during an AI run would otherwise use up the head's one automatic
 * try. Only a person's event cancels a run, so this cannot loop.
 *
 * @param {{ name: string, status?: string, conclusion?: string | null }[]} jobs
 */
export function classifyRun(jobs) {
  const preview = jobs.find((j) => j.name === PREVIEW_JOB);
  const docsOnly = preview?.conclusion === 'skipped';
  const iosRan = jobs.some(
    (j) => j.name.startsWith(IOS_JOB_PREFIX) && j.conclusion !== 'skipped',
  );
  const ai = jobs.find((j) => j.name === AI_JOB);
  return {
    docsOnly,
    known: Boolean(preview) && (docsOnly || iosRan),
    aiPassed: ai?.conclusion === 'success',
    aiAttempted: Boolean(ai) && !['skipped', 'cancelled'].includes(String(ai?.conclusion)),
  };
}

/**
 * Has the AI shard passed — or been tried — on ANY CI run for this head sha?
 * The same commit is the same code, so a pass on an earlier run counts; and a
 * try on any run uses up the one automatic attempt, so a red or flaky AI run
 * is never relabelled into a loop.
 *
 * @param {Parameters<typeof classifyRun>[0][]} runsJobs
 */
export function aiHistory(runsJobs) {
  const runs = runsJobs.map(classifyRun);
  return {
    passed: runs.some((r) => r.aiPassed),
    attempted: runs.some((r) => r.aiAttempted),
  };
}

/** @param {string} p */
export function isTestPath(p) {
  return (
    /\.test\.(ts|tsx|js|mjs)$/.test(p) ||
    p.startsWith('e2e/') ||
    p.startsWith('mobile/maestro/') ||
    p.startsWith('src/test/')
  );
}

/** @param {string} p */
export function isAppPath(p) {
  return (p.startsWith('src/') || p.startsWith('mobile/')) && !isTestPath(p) && !p.endsWith('.md');
}

/**
 * The app files a PR changes without changing any test, or [] when it is fine:
 * it changes no app code, it changes a test, or it carries `no-tests-needed`.
 *
 * @param {string[]} files
 * @param {string[]} labels
 */
export function missingTests(files, labels) {
  if (labels.includes(LABEL.noTests)) return [];
  if (files.some(isTestPath)) return [];
  return files.filter(isAppPath);
}

/**
 * @typedef {{
 *   action: 'skip' | 'label-ai' | 'update-branch' | 'merge' | 'comment-conflict' | 'comment-tests-missing',
 *   reason: string,
 *   files?: string[],
 *   clear?: (keyof typeof MARKER)[],
 * }} Decision
 */

/**
 * What a completed CI run means for its PR. The order is deliberate, cheapest
 * fix first and Penny spend last: a PR that cannot merge anyway (no tests, a
 * conflict, behind main) is not sent to the AI shard, because the commit that
 * fixes it needs its own AI run.
 *
 * @param {Parameters<typeof guardPr>[0] & {
 *   jobs: Parameters<typeof classifyRun>[0],
 *   ai: ReturnType<typeof aiHistory>,
 *   files: string[],
 *   mergeableState: string,
 * }} s
 * @returns {Decision}
 */
export function decideAfterCi(s) {
  const guard = guardPr(s);
  if (guard) return { action: 'skip', reason: guard };
  const pr = /** @type {NonNullable<typeof s.pr>} */ (s.pr);

  const run = classifyRun(s.jobs);
  if (!run.known) {
    return {
      action: 'skip',
      reason: `cannot tell from run ${s.run.id}'s jobs whether it was docs-only or ran the iOS shards — was "${PREVIEW_JOB}" or "${IOS_JOB_PREFIX}<shard>" renamed in ci.yml?`,
    };
  }

  const missing = missingTests(s.files, pr.labels);
  if (missing.length > 0) {
    return {
      action: 'comment-tests-missing',
      reason: `changes app code (${missing.length} file(s)) but no test, and has no \`${LABEL.noTests}\` label`,
      files: missing,
    };
  }
  /** @type {Decision['clear']} */
  const clear = ['testsMissing'];

  if (s.mergeableState === 'dirty') {
    return { action: 'comment-conflict', reason: 'conflicts with main', clear };
  }
  clear.push('conflict');
  if (s.mergeableState === 'behind') {
    return { action: 'update-branch', reason: 'behind main; merging main in', clear };
  }

  if (!run.docsOnly && !s.ai.passed) {
    if (s.ai.attempted) {
      return {
        action: 'skip',
        reason: `the AI shard already ran on ${short(s.run.headSha)} and did not pass; push a fix, or remove and re-add \`${LABEL.ai}\` to retry`,
        clear,
      };
    }
    return { action: 'label-ai', reason: `green without the AI shard; adding \`${LABEL.ai}\``, clear };
  }

  if (MERGEABLE.has(s.mergeableState)) {
    const why = run.docsOnly ? 'docs-only, green' : 'green, AI shard passed';
    return { action: 'merge', reason: `${why}, ${s.mergeableState}`, clear };
  }
  return { action: 'skip', reason: `GitHub says mergeable_state=${s.mergeableState}`, clear };
}

/**
 * After a push to main: does this open PR need main merged in?
 *
 * @param {{ pr: ReturnType<typeof normalisePr>, behindBy: number }} s
 * @returns {{ action: 'skip' | 'update-branch', reason: string }}
 */
export function decideForOpenPr({ pr, behindBy }) {
  const skip = prSkipReason(pr);
  if (skip) return { action: 'skip', reason: skip };
  if (behindBy > 0) return { action: 'update-branch', reason: `${behindBy} commit(s) behind main` };
  return { action: 'skip', reason: 'up to date with main' };
}

/** @param {string[]} files */
export function testsMissingBody(files) {
  const listed = files.slice(0, 15).map((f) => `- \`${f}\``);
  if (files.length > 15) listed.push(`- …and ${files.length - 15} more`);
  return [
    MARKER.testsMissing,
    '**Auto-merge is holding this PR: it changes app code and no test.**',
    '',
    ...listed,
    '',
    `Push a unit test (\`*.test.ts\`/\`*.test.tsx\`), a Playwright spec (\`e2e/\`) or a Maestro flow (\`mobile/maestro/\`) — or add the \`${LABEL.noTests}\` label if this change genuinely needs none.`,
  ].join('\n');
}

export const CONFLICT_BODY = [
  MARKER.conflict,
  '**Auto-merge cannot bring this PR up to date: it conflicts with `main`.**',
  '',
  'Merge `main` into the branch and resolve the conflicts by hand. The next green CI run picks it up again.',
].join('\n');

// ── Orchestration (all GitHub access goes through io.gh) ────────────────────

/**
 * @typedef {{
 *   gh: (args: string[]) => { ok: boolean, stdout: string, stderr: string },
 *   sleep: (ms: number) => void,
 *   log: (line: string) => void,
 * }} Io
 */

/** @param {Io} io */
function client(io, repo) {
  const call = (args) => {
    const r = io.gh(args);
    if (!r.ok) throw new GhError(args, r.stderr);
    return r.stdout;
  };
  const json = (args) => JSON.parse(call(args));
  const lines = (args) => call(args).split('\n').filter(Boolean);
  const getPr = (n) => normalisePr(json(['api', `repos/${repo}/pulls/${n}`]));
  return {
    call,
    getPr,
    runsFor: (sha) =>
      json([
        'run', 'list', '-R', repo, '--workflow', CI_WORKFLOW, '--commit', sha,
        '--limit', '20', '--json', 'databaseId,status,conclusion',
      ]),
    jobsOf: (id) => json(['run', 'view', String(id), '-R', repo, '--json', 'jobs']).jobs ?? [],
    prsForSha: (sha) =>
      lines(['api', `repos/${repo}/commits/${sha}/pulls`, '--jq', '.[] | select(.state == "open") | .number']).map(Number),
    files: (n) => lines(['api', '--paginate', `repos/${repo}/pulls/${n}/files?per_page=100`, '--jq', '.[].filename']),
    stickies: (n) =>
      lines([
        'api', '--paginate', `repos/${repo}/issues/${n}/comments?per_page=100`,
        '--jq', '.[] | select(.body | startswith("<!-- auto-merge:")) | {id, body} | tojson',
      ]).map((l) => JSON.parse(l)),
    openPrs: () =>
      lines(['api', '--paginate', `repos/${repo}/pulls?state=open&base=main&per_page=100`, '--jq', '.[] | tojson'])
        .map((l) => normalisePr(JSON.parse(l))),
    behindBy: (base, head) =>
      Number(call(['api', `repos/${repo}/compare/${base}...${head}`, '--jq', '.behind_by']).trim()),
    // Writes. Every one of these is a write to tokenFor, so it carries the PAT.
    updateBranch: (n, sha) =>
      call(['api', '-X', 'PUT', `repos/${repo}/pulls/${n}/update-branch`, '-f', `expected_head_sha=${sha}`]),
    merge: (n, sha) => call(['pr', 'merge', String(n), '-R', repo, '--merge', '--match-head-commit', sha]),
    removeLabel: (n, label) =>
      call(['api', '-X', 'DELETE', `repos/${repo}/issues/${n}/labels/${encodeURIComponent(label)}`]),
    addLabel: (n, label) => call(['api', '-X', 'POST', `repos/${repo}/issues/${n}/labels`, '-f', `labels[]=${label}`]),
    comment: (n, body) => call(['api', '-X', 'POST', `repos/${repo}/issues/${n}/comments`, '-f', `body=${body}`]),
    editComment: (id, body) => call(['api', '-X', 'PATCH', `repos/${repo}/issues/comments/${id}`, '-f', `body=${body}`]),
    deleteComment: (id) => call(['api', '-X', 'DELETE', `repos/${repo}/issues/comments/${id}`]),
  };
}

/** GitHub computes mergeability lazily; ask again for up to ~30s. */
function settledMergeableState(io, gh, pr) {
  let state = pr.mergeableState;
  for (let i = 0; state === 'unknown' && i < 10; i++) {
    io.sleep(3000);
    state = gh.getPr(pr.number).mergeableState;
  }
  return state;
}

/** Post the conflict comment unless one is already there. */
function postConflictOnce(gh, n, stickies) {
  if (stickies.some((c) => c.body.startsWith(MARKER.conflict))) return 'conflict comment already posted';
  gh.comment(n, CONFLICT_BODY);
  return 'posted the conflict comment';
}

/**
 * Bring a PR up to date. A conflict gets the sticky comment; a head that moved
 * since we looked is left to the CI run that push started.
 */
function updateBranch(gh, pr, stickies) {
  try {
    gh.updateBranch(pr.number, pr.headSha);
    return 'merged main in';
  } catch (e) {
    if (!(e instanceof GhError) || e.kind === 'token-rejected') throw e;
    if (e.kind === 'head-moved') return `head moved since ${short(pr.headSha)}; its own CI run will decide`;
    if (e.kind === 'conflict' || gh.getPr(pr.number).mergeable === false) {
      return postConflictOnce(gh, pr.number, stickies ?? gh.stickies(pr.number));
    }
    throw e;
  }
}

/**
 * A CI run completed.
 *
 * @param {Io} io
 * @param {{ repo: string, run: { id: number, headSha: string, conclusion: string, pullRequests: number[] } }} ctx
 * @returns {Decision & { pr?: number, outcome?: string, warning?: boolean }}
 */
export function onCiCompleted(io, { repo, run }) {
  const gh = client(io, repo);

  const candidates = run.pullRequests.length > 0 ? run.pullRequests : gh.prsForSha(run.headSha);
  const pr = candidates.length > 0 ? gh.getPr(candidates[0]) : null;
  const runs = gh.runsFor(run.headSha);
  const latestRunId = runs[0]?.databaseId;

  const guard = guardPr({ run, pr, latestRunId });
  if (guard) return { action: 'skip', reason: guard, pr: pr?.number };
  const open = /** @type {NonNullable<typeof pr>} */ (pr);

  const jobs = gh.jobsOf(run.id);
  const thisRun = classifyRun(jobs);
  const others = thisRun.aiPassed || thisRun.docsOnly
    ? []
    : runs.filter((r) => r.databaseId !== run.id).map((r) => gh.jobsOf(r.databaseId));
  const decision = decideAfterCi({
    run,
    pr: open,
    latestRunId,
    jobs,
    ai: aiHistory([jobs, ...others]),
    files: gh.files(open.number),
    mergeableState: settledMergeableState(io, gh, open),
  });

  const stickies = gh.stickies(open.number);
  let outcome = '';
  let warning = false;
  switch (decision.action) {
    case 'label-ai':
      // A label already on the PR fires no `labeled` event: take it off first.
      if (open.labels.includes(LABEL.ai)) gh.removeLabel(open.number, LABEL.ai);
      gh.addLabel(open.number, LABEL.ai);
      outcome = `added \`${LABEL.ai}\``;
      break;
    case 'update-branch':
      outcome = updateBranch(gh, open, stickies);
      break;
    case 'merge':
      try {
        gh.merge(open.number, open.headSha);
        outcome = `merged ${short(open.headSha)}`;
      } catch (e) {
        // Lost a race (main moved, a push landed): the push-to-main job or the
        // next CI run picks it up. A rejected token is still fatal.
        if (!(e instanceof GhError) || e.kind === 'token-rejected') throw e;
        outcome = `merge refused, left for the next run: ${e.message}`;
        warning = true;
      }
      break;
    case 'comment-conflict':
      outcome = postConflictOnce(gh, open.number, stickies);
      break;
    case 'comment-tests-missing': {
      const body = testsMissingBody(decision.files ?? []);
      const existing = stickies.find((c) => c.body.startsWith(MARKER.testsMissing));
      if (!existing) gh.comment(open.number, body);
      else if (existing.body !== body) gh.editComment(existing.id, body);
      outcome = 'tests-missing comment in place';
      break;
    }
    default:
      break;
  }
  // A sticky whose condition no longer holds would mislead: remove it.
  for (const key of decision.clear ?? []) {
    for (const c of stickies) if (c.body.startsWith(MARKER[key])) gh.deleteComment(c.id);
  }
  return { ...decision, pr: open.number, outcome, warning };
}

/**
 * Main moved. Merge it into every open PR that is behind; one PR's failure
 * never stops the others. Throws only when the token itself is rejected.
 *
 * @param {Io} io
 * @param {{ repo: string, mainSha: string }} ctx
 */
export function onMainPush(io, { repo, mainSha }) {
  const gh = client(io, repo);
  const results = [];
  for (const pr of gh.openPrs()) {
    try {
      const skip = prSkipReason(pr);
      const d = skip
        ? { action: 'skip', reason: skip }
        : decideForOpenPr({ pr, behindBy: gh.behindBy(mainSha, pr.headSha) });
      const outcome = d.action === 'update-branch' ? updateBranch(gh, pr, null) : d.reason;
      results.push({ pr: pr.number, ok: true, outcome });
    } catch (e) {
      if (e instanceof GhError && e.kind === 'token-rejected') throw e;
      results.push({ pr: pr.number, ok: false, outcome: e instanceof Error ? e.message : String(e) });
    }
  }
  return results;
}

/**
 * The entry point, minus process globals. Returns the exit code.
 *
 * @param {{ env: Record<string, string | undefined>, event: any, io: Io }} p
 */
export function run({ env, event, io }) {
  if (!env.AUTO_UPDATE_TOKEN) {
    io.log('::notice::AUTO_UPDATE_TOKEN is not set, so auto-merge did nothing. See docs/design/auto-merge.md.');
    return 0;
  }
  const repo = String(env.GITHUB_REPOSITORY);
  try {
    if (env.GITHUB_EVENT_NAME === 'workflow_run') {
      const wr = event.workflow_run;
      if (wr.event !== 'pull_request') {
        io.log(`::notice::CI run ${wr.id} came from a ${wr.event} event, not a pull request; nothing to do.`);
        return 0;
      }
      const d = onCiCompleted(io, {
        repo,
        run: {
          id: wr.id,
          headSha: wr.head_sha,
          conclusion: wr.conclusion,
          pullRequests: (wr.pull_requests ?? []).map((p) => p.number),
        },
      });
      const who = d.pr ? `PR #${d.pr}` : `run ${wr.id}`;
      io.log(`${d.warning ? '::warning::' : '::notice::'}${who}: ${d.action} — ${d.reason}${d.outcome ? ` → ${d.outcome}` : ''}`);
      return 0;
    }
    if (env.GITHUB_EVENT_NAME === 'push') {
      const results = onMainPush(io, { repo, mainSha: String(env.GITHUB_SHA) });
      for (const r of results) io.log(`${r.ok ? '' : '::warning::'}PR #${r.pr}: ${r.outcome}`);
      if (results.length === 0) io.log('No open pull requests into main.');
      return 0;
    }
    io.log(`::notice::Nothing to do for a ${env.GITHUB_EVENT_NAME} event.`);
    return 0;
  } catch (e) {
    if (e instanceof GhError && e.kind === 'token-rejected') {
      io.log(`::error::GitHub rejected AUTO_UPDATE_TOKEN (expired, revoked, or missing a permission: it needs Contents, Pull requests and Workflows, read and write, on this repo). ${e.message}`);
      return 1;
    }
    io.log(`::error::${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

/** @param {Record<string, string | undefined>} env @returns {Io} */
export function realIo(env) {
  return {
    gh(args) {
      try {
        const stdout = execFileSync('gh', args, {
          encoding: 'utf8',
          env: { ...env, GH_TOKEN: tokenFor(args, env), GH_PROMPT_DISABLED: '1' },
          stdio: ['ignore', 'pipe', 'pipe'],
          maxBuffer: 64 * 1024 * 1024,
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
    log(line) {
      console.log(line);
      if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${line.replace(/^::\w+::/, '')}\n`);
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = process.env;
  const event = env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8')) : {};
  process.exit(run({ env, event, io: realIo(env) }));
}
