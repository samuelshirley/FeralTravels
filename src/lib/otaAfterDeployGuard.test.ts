import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * Nothing reaches a device — neither an OTA bundle nor a TestFlight binary —
 * before production serves the API it was written against (issue #39).
 *
 * A push to `main` starts mobile.yml and deploy-production.yml at once and
 * nothing ordered them. Measured on the last three JS-only merges before this
 * guard (906537a, 6281e36, c9dbcd0): the OTA published 14s, 8s and 4s after
 * the production deploy finished — the right order by luck, and a failed
 * deploy would have left the bundle out there with no API at all.
 *
 * Two halves:
 *  - STRUCTURE: the wait step sits before both shipping steps, runs whenever
 *    either would, and nothing lets either run past a failed wait.
 *  - BEHAVIOUR: the step's own `run:` block, lifted out of the YAML and
 *    executed under bash against a stub `gh` and a real throwaway git origin,
 *    passes only when production serves this commit — its own deploy
 *    succeeded, or it was superseded by a later main deploy that contains it
 *    and succeeded — and fails on everything else.
 */

const ROOT = path.join(__dirname, '..', '..');
const mobile = readFileSync(path.join(ROOT, '.github/workflows/mobile.yml'), 'utf8');
const deploy = readFileSync(path.join(ROOT, '.github/workflows/deploy-production.yml'), 'utf8');

const WAIT_STEP = 'Wait for the production deploy of this commit';
const OTA_STEP = 'Publish the OTA';
const BUILD_STEP = 'Build and submit to TestFlight';

/** A step's lines, from its `- name:` to the next step at the same indent. */
function step(name: string): string[] {
  const lines = mobile.split('\n');
  const start = lines.findIndex((l) => l.trimEnd() === `      - name: ${name}`);
  expect(start, `mobile.yml has no step named "${name}"`).toBeGreaterThan(-1);
  let end = start + 1;
  while (end < lines.length && !/^ {6}- /.test(lines[end]) && !/^ {2}\S/.test(lines[end])) end++;
  return lines.slice(start, end);
}

const field = (lines: string[], key: string) =>
  lines.find((l) => l.startsWith(`        ${key}:`))?.slice(`        ${key}:`.length).trim();

const envValue = (lines: string[], key: string) => {
  const raw = lines.find((l) => l.startsWith(`          ${key}:`))?.split(':')[1]?.trim();
  return raw === undefined ? undefined : Number(raw.replace(/'/g, ''));
};

/** The `run: |` block, dedented, exactly as the runner would hand it to bash. */
function runBlock(lines: string[]): string {
  const at = lines.findIndex((l) => l === '        run: |');
  expect(at, `"${WAIT_STEP}" has no run: | block`).toBeGreaterThan(-1);
  return lines
    .slice(at + 1)
    .map((l) => l.slice(10))
    .join('\n');
}

const minutes = (text: string, job: string) => {
  const m = text.match(new RegExp(`\\n  ${job}:[\\s\\S]*?timeout-minutes: (\\d+)`));
  expect(m, `no timeout-minutes for job ${job}`).not.toBeNull();
  return Number(m![1]);
};

describe('mobile.yml: nothing ships to a device before the production deploy (structure)', () => {
  const wait = step(WAIT_STEP);
  const ota = step(OTA_STEP);
  const build = step(BUILD_STEP);

  it('the wait comes before both shipping steps', () => {
    const at = (name: string) => mobile.indexOf(`- name: ${name}`);
    expect(at(WAIT_STEP)).toBeLessThan(at(OTA_STEP));
    expect(at(WAIT_STEP)).toBeLessThan(at(BUILD_STEP));
  });

  it('the wait runs exactly when either shipping step would', () => {
    // Built from the two gates rather than restated: widening either one
    // without widening the wait is the regression this catches.
    expect(field(ota, 'if')).toBe("steps.native.outputs.decision == 'js-only'");
    expect(field(wait, 'if')).toBe(`${field(ota, 'if')} || ${field(build, 'if')}`);
  });

  it('nothing lets a shipping step run past a failed wait', () => {
    // An `always()` / `failure()` / `!cancelled()` on either, or
    // `continue-on-error` on the wait, would turn the gate into a log line.
    for (const s of [ota, build]) {
      expect(field(s, 'if')).not.toMatch(/always\(\)|failure\(\)|cancelled\(\)/);
    }
    expect(field(wait, 'continue-on-error')).toBeUndefined();
  });

  it('asks about THIS commit, and about later deploys on main only, by the name deploy-production.yml has', () => {
    const run = runBlock(wait);
    expect(run).toContain(`--workflow 'Deploy to production' --commit "$GITHUB_SHA"`);
    expect(run).toContain(`--workflow 'Deploy to production' --branch main`);
    expect(run).toContain('git merge-base --is-ancestor "$GITHUB_SHA" "$sha"');
    expect(deploy).toMatch(/^name: Deploy to production$/m);
  });

  it('may read Actions runs', () => {
    // With `permissions:` set, an unlisted scope is `none` and `gh run list`
    // is refused — which the step would report as a timeout 45 minutes later.
    expect(mobile).toMatch(/^permissions:\n(?: {2}.*\n)*? {2}actions: read$/m);
  });

  it('waits longer than a deploy may take, and a native build still fits after it', () => {
    // Native runs measured at 84 and 74 minutes (2026-09). A job killed
    // mid-build leaves an EAS build nothing tracks.
    const waitS = envValue(wait, 'WAIT_SECONDS')!;
    expect(waitS).toBeGreaterThanOrEqual(minutes(deploy, 'deploy') * 60 * 2);
    expect(waitS + 90 * 60 + 15 * 60).toBeLessThanOrEqual(minutes(mobile, 'ship') * 60);
  });

  it('keeps the push trigger, so the classifier still has github.event.before', () => {
    // A `workflow_run` trigger carries no `before`: every merge would classify
    // as native, skipping the OTA and spending a build credit, forever.
    expect(mobile).not.toMatch(/^\s*workflow_run:/m);
    expect(mobile).toContain('BEFORE: ${{ github.event.before }}');
  });
});

describe('mobile.yml: the wait step itself (behaviour, under bash, stub gh, real git)', () => {
  const script = runBlock(step(WAIT_STEP));
  const root = mkdtempSync(path.join(tmpdir(), 'ota-wait-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
      },
    }).trim();
  const commit = (cwd: string, msg: string) => {
    git(cwd, 'commit', '--allow-empty', '-q', '-m', msg);
    return git(cwd, 'rev-parse', 'HEAD');
  };

  // P <- SHA <- LATER on main; FEATURE branches off SHA and never reaches main.
  // The job's checkout is taken when SHA is main's tip, exactly as a push run's is.
  const origin = path.join(root, 'origin.git');
  const author = path.join(root, 'author');
  const work = path.join(root, 'work');
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  git(root, 'clone', '-q', origin, author);
  git(author, 'checkout', '-q', '-b', 'main');
  const PARENT = commit(author, 'parent');
  const SHA = commit(author, 'this merge');
  git(author, 'push', '-q', 'origin', 'main');
  git(root, 'clone', '-q', origin, work);
  const LATER = commit(author, 'a later merge');
  git(author, 'push', '-q', 'origin', 'main');
  git(author, 'checkout', '-q', '-b', 'feature', SHA);
  const FEATURE = commit(author, 'a feature branch');
  git(author, 'push', '-q', 'origin', 'feature');

  let n = 0;
  /**
   * `states`: what the stub prints for the `--commit` query, one per call,
   * the last repeated. `later`: blocks of "<sha> <status>/<conclusion>" lines
   * for the `--branch main` query, likewise. `'!'` makes that call fail, as
   * an API error would.
   */
  function run(states: string[], later: string[][] = [[]], env: Record<string, string> = {}) {
    const dir = path.join(root, `stub-${n++}`);
    execFileSync('mkdir', [dir]);
    writeFileSync(path.join(dir, 'states'), states.join('\n') + '\n');
    writeFileSync(path.join(dir, 'later'), later.map((b) => b.join('\n')).join('\n---\n') + '\n');
    writeFileSync(
      path.join(dir, 'gh'),
      [
        '#!/usr/bin/env bash',
        `d='${dir}'`,
        'printf "%s\\n" "$*" >> "$d/args"',
        'next() { local c=$(( $(cat "$d/$1" 2>/dev/null || echo 0) + 1 )); echo $c > "$d/$1"; echo $c; }',
        'case "$*" in',
        '  *--commit*)',
        '    k=$(next n); total=$(wc -l < "$d/states")',
        '    s=$(sed -n "$(( k < total ? k : total ))p" "$d/states")',
        '    [ "$s" = "!" ] && exit 1; echo "$s" ;;',
        '  *--branch\\ main*)',
        '    k=$(next m); total=$(( $(grep -c "^---$" "$d/later") + 1 ))',
        '    out=$(awk -v k=$(( k < total ? k : total )) \'BEGIN{b=1} /^---$/{b++; next} b==k\' "$d/later")',
        '    [ "$out" = "!" ] && exit 1; [ -n "$out" ] && echo "$out"; exit 0 ;;',
        '  *) echo "unexpected gh call: $*" >&2; exit 2 ;;',
        'esac',
      ].join('\n')
    );
    chmodSync(path.join(dir, 'gh'), 0o755);
    const r = spawnSync('bash', ['-c', script], {
      cwd: work,
      encoding: 'utf8',
      timeout: 20_000,
      env: {
        NODE_ENV: 'test',
        PATH: `${dir}:${process.env.PATH}`,
        HOME: process.env.HOME,
        GITHUB_SHA: SHA,
        GITHUB_REPOSITORY: 'samuelshirley/FeralTravels',
        GH_TOKEN: 'stub',
        WAIT_SECONDS: '600',
        POLL_SECONDS: '0',
        GRACE_SECONDS: '600',
        ...env,
      },
    });
    const calls = Number(readFileSync(path.join(dir, 'n'), 'utf8'));
    const args = readFileSync(path.join(dir, 'args'), 'utf8');
    return { code: r.status, out: r.stdout + r.stderr, calls, args };
  }
  const short = (sha: string) => sha.slice(0, 7);
  const FAST = { WAIT_SECONDS: '1', GRACE_SECONDS: '1', POLL_SECONDS: '0.2' };

  it('waits through queued and in-progress, then ships on success', () => {
    const r = run(['none', 'queued/pending', 'in_progress/pending', 'completed/success']);
    expect(r.code).toBe(0);
    expect(r.calls).toBe(4);
    expect(r.args).toContain(`--workflow Deploy to production --commit ${SHA}`);
  });

  it('a failed deploy fails the job', () => {
    const r = run(['in_progress/pending', 'completed/failure']);
    expect(r.code).toBe(1);
    expect(r.out).toContain(`::error::Deploy to production for ${short(SHA)} ended failure`);
  });

  it('any other conclusion fails the job (timed_out, skipped, startup_failure)', () => {
    for (const c of ['timed_out', 'skipped', 'startup_failure', 'action_required']) {
      expect(run([`completed/${c}`]).code, c).toBe(1);
    }
  });

  it('superseded: a later main deploy that contains this commit succeeded — ships', () => {
    const r = run(['completed/cancelled'], [[`${LATER} completed/success`]]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`${short(LATER)} contains it and deployed`);
    expect(r.args).toContain('--workflow Deploy to production --branch main');
  });

  it('superseded: waits while the later deploy is still running, then ships', () => {
    const r = run(['completed/cancelled'], [
      [`${LATER} queued/pending`],
      [`${LATER} in_progress/pending`],
      [`${LATER} completed/success`],
    ]);
    expect(r.code).toBe(0);
  });

  it('superseded, and the later deploy failed too — fails', () => {
    const r = run(['completed/cancelled'], [[`${LATER} completed/failure`]]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/::error::.*was cancelled, and every later deploy that contains it ended without success/);
  });

  it('cancelled, and the only successes do NOT contain this commit — fails after the grace', () => {
    // PARENT is older; FEATURE descends from it but never reached main (and
    // `--branch main` would not list it anyway). Neither proves anything.
    const r = run(['completed/cancelled'], [[`${PARENT} completed/success`, `${FEATURE} completed/success`]], FAST);
    expect(r.code).toBe(1);
    expect(r.out).toContain('::error::Deploy to production for ' + short(SHA) + ' was cancelled, and no later deploy on main contains it');
  });

  it('cancelled, then THIS commit is re-run and succeeds — ships', () => {
    const r = run(['completed/cancelled', 'completed/success'], [[]]);
    expect(r.code).toBe(0);
  });

  it('no run at all fails once the grace period is over', () => {
    const r = run(['none'], [[]], FAST);
    expect(r.code).toBe(1);
    expect(r.out).toContain(`::error::No Deploy to production run exists for ${short(SHA)}`);
  });

  it('a deploy that never finishes fails at the deadline, not silently', () => {
    const r = run(['in_progress/pending'], [[]], FAST);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/::error::Gave up after \d+s .*last state: in_progress\/pending/);
  });

  it('a transient API error is retried, not fatal and not a pass', () => {
    const ok = run(['!', 'in_progress/pending', 'completed/success']);
    expect(ok.code).toBe(0);
    expect(ok.calls).toBe(3);
    const dead = run(['!'], [[]], FAST);
    expect(dead.code).toBe(1);
    expect(dead.out).toContain('last state: api-error');
    const laterDown = run(['completed/cancelled'], [['!'], [`${LATER} completed/success`]]);
    expect(laterDown.code).toBe(0);
  });
});
