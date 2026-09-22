import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * An OTA bundle never reaches phones before the API it was written against
 * (issue #39).
 *
 * A push to `main` starts mobile.yml and deploy-production.yml at once and
 * nothing ordered them. Measured on the last three JS-only merges before this
 * guard (906537a, 6281e36, c9dbcd0): the OTA published 14s, 8s and 4s after
 * the production deploy finished — the right order by luck, and a failed
 * deploy would have left the bundle out there with no API at all.
 *
 * Two halves:
 *  - STRUCTURE: the wait step sits before "Publish the OTA", under the same
 *    gate, and nothing lets the publish run past a failed wait.
 *  - BEHAVIOUR: the step's own `run:` block, lifted out of the YAML and
 *    executed under bash against a stub `gh`, publishes only on
 *    `completed/success` and fails on everything else.
 */

const ROOT = path.join(__dirname, '..', '..');
const mobile = readFileSync(path.join(ROOT, '.github/workflows/mobile.yml'), 'utf8');
const deploy = readFileSync(path.join(ROOT, '.github/workflows/deploy-production.yml'), 'utf8');

const WAIT_STEP = 'Wait for the production deploy of this commit';
const OTA_STEP = 'Publish the OTA';

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

describe('mobile.yml: the OTA waits for the production deploy (structure)', () => {
  const wait = step(WAIT_STEP);
  const ota = step(OTA_STEP);

  it('the wait comes before the publish', () => {
    expect(mobile.indexOf(`- name: ${WAIT_STEP}`)).toBeLessThan(mobile.indexOf(`- name: ${OTA_STEP}`));
  });

  it("the wait is gated exactly like the publish, so it can never be skipped while the publish runs", () => {
    expect(field(wait, 'if')).toBe("steps.native.outputs.decision == 'js-only'");
    expect(field(ota, 'if')).toBe(field(wait, 'if'));
  });

  it('nothing lets the publish run past a failed wait', () => {
    // An `always()` / `failure()` / `!cancelled()` on the publish, or
    // `continue-on-error` on the wait, would turn the gate into a log line.
    expect(field(ota, 'if')).not.toMatch(/always\(\)|failure\(\)|cancelled\(\)/);
    expect(field(wait, 'continue-on-error')).toBeUndefined();
  });

  it('asks about THIS commit, by the name deploy-production.yml actually has', () => {
    const run = runBlock(wait);
    expect(run).toContain(`--workflow 'Deploy to production'`);
    expect(run).toContain('--commit "$GITHUB_SHA"');
    expect(deploy).toMatch(/^name: Deploy to production$/m);
  });

  it('may read Actions runs', () => {
    // With `permissions:` set, an unlisted scope is `none` and `gh run list`
    // is refused — which the step would report as a timeout 45 minutes later.
    expect(mobile).toMatch(/^permissions:\n(?: {2}.*\n)*? {2}actions: read$/m);
  });

  it("waits longer than a deploy may take, and fits inside the job's own timeout", () => {
    const waitS = envValue(wait, 'WAIT_SECONDS')!;
    expect(waitS).toBeGreaterThanOrEqual(minutes(deploy, 'deploy') * 60 * 2);
    expect(waitS).toBeLessThan(minutes(mobile, 'ship') * 60 - 20 * 60);
  });

  it('keeps the push trigger, so the classifier still has github.event.before', () => {
    // A `workflow_run` trigger carries no `before`: every merge would classify
    // as native, skipping the OTA and spending a build credit, forever.
    expect(mobile).not.toMatch(/^\s*workflow_run:/m);
    expect(mobile).toContain('BEFORE: ${{ github.event.before }}');
  });
});

describe('mobile.yml: the wait step itself (behaviour, under bash, stub gh)', () => {
  const script = runBlock(step(WAIT_STEP));
  const SHA = '0123456789abcdef0123456789abcdef01234567';
  const dirs: string[] = [];
  afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

  /**
   * `states` is what the stub `gh` prints, one per call, the last repeated.
   * `'!'` makes that call exit non-zero, as an API error would.
   */
  function run(states: string[], env: Record<string, string> = {}) {
    const dir = mkdtempSync(path.join(tmpdir(), 'ota-wait-'));
    dirs.push(dir);
    writeFileSync(path.join(dir, 'states'), states.join('\n') + '\n');
    writeFileSync(
      path.join(dir, 'gh'),
      [
        '#!/usr/bin/env bash',
        `d='${dir}'`,
        'printf "%s\\n" "$*" >> "$d/args"',
        'n=$(( $(cat "$d/n" 2>/dev/null || echo 0) + 1 )); echo $n > "$d/n"',
        'total=$(wc -l < "$d/states")',
        's=$(sed -n "$(( n < total ? n : total ))p" "$d/states")',
        '[ "$s" = "!" ] && exit 1',
        'echo "$s"',
      ].join('\n')
    );
    chmodSync(path.join(dir, 'gh'), 0o755);
    const r = spawnSync('bash', ['-c', script], {
      encoding: 'utf8',
      timeout: 20_000,
      env: {
        NODE_ENV: 'test',
        PATH: `${dir}:${process.env.PATH}`,
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

  it('waits through queued and in-progress, then publishes on success', () => {
    const r = run(['none', 'queued/pending', 'in_progress/pending', 'completed/success']);
    expect(r.code).toBe(0);
    expect(r.calls).toBe(4);
    expect(r.args).toContain(`--workflow Deploy to production --commit ${SHA}`);
  });

  it('a failed deploy fails the job', () => {
    const r = run(['in_progress/pending', 'completed/failure']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('::error::Deploy to production for 0123456 ended failure');
  });

  it('a cancelled deploy fails the job, and says why that usually happens', () => {
    const r = run(['completed/cancelled']);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/::error::.*was cancelled.*superseded/);
  });

  it('any other conclusion fails the job (timed_out, skipped, startup_failure)', () => {
    for (const c of ['timed_out', 'skipped', 'startup_failure', 'action_required']) {
      expect(run([`completed/${c}`]).code, c).toBe(1);
    }
  });

  it('no run at all fails once the grace period is over', () => {
    const r = run(['none'], { GRACE_SECONDS: '1', POLL_SECONDS: '0.2' });
    expect(r.code).toBe(1);
    expect(r.out).toContain('::error::No Deploy to production run exists for 0123456');
  });

  it('a deploy that never finishes fails at the deadline, not silently', () => {
    const r = run(['in_progress/pending'], { WAIT_SECONDS: '1', POLL_SECONDS: '0.2' });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/::error::Gave up after \d+s .*last state: in_progress\/pending/);
  });

  it('a transient API error is retried, not fatal and not a pass', () => {
    const ok = run(['!', 'in_progress/pending', 'completed/success']);
    expect(ok.code).toBe(0);
    expect(ok.calls).toBe(3);
    const dead = run(['!'], { WAIT_SECONDS: '1', POLL_SECONDS: '0.2' });
    expect(dead.code).toBe(1);
    expect(dead.out).toContain('last state: api-error');
  });
});
