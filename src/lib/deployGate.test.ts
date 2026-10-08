import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * deploy-production.yml's CI gate WAITS for a CI run that is still going, and
 * deploys only if it comes back green.
 *
 * 2026-10-01: PR #79 got the `ai-tests` label at 11:36:30 and was merged at
 * 11:36:31. The label started a new CI run on the same head sha; the gate read
 * that run as in_progress and exited 1 (deploy run 36856433646), so production
 * stayed a merge behind with nothing to say so but a red run.
 *
 * The step's own `run:` block, lifted out of the YAML and executed under bash
 * against a stub `gh` (and a stub `git` for the checkout's HEAD), with the
 * poll interval and ceiling shrunk through the step's env.
 */

const ROOT = path.join(__dirname, '..', '..');
const deploy = readFileSync(path.join(ROOT, '.github/workflows/deploy-production.yml'), 'utf8');
const GATE_STEP = 'Require green CI for this commit';

function gateStep(): string[] {
  const lines = deploy.split('\n');
  const start = lines.findIndex((l) => l.trimEnd() === `      - name: ${GATE_STEP}`);
  expect(start, `deploy-production.yml has no step named "${GATE_STEP}"`).toBeGreaterThan(-1);
  let end = start + 1;
  while (end < lines.length && !/^ {6}- /.test(lines[end]) && !/^ {2}\S/.test(lines[end])) end++;
  return lines.slice(start, end);
}

const envValue = (lines: string[], key: string) => {
  const raw = lines.find((l) => l.startsWith(`          ${key}:`))?.split(':')[1]?.trim();
  expect(raw, `"${GATE_STEP}" sets no ${key}`).toBeDefined();
  return Number(raw!.replace(/'/g, ''));
};

function runBlock(lines: string[]): string {
  const at = lines.findIndex((l) => l === '        run: |');
  expect(at, `"${GATE_STEP}" has no run: | block`).toBeGreaterThan(-1);
  return lines
    .slice(at + 1)
    .map((l) => l.slice(10))
    .join('\n');
}

describe('deploy-production.yml: the CI gate is sized to wait', () => {
  const gate = gateStep();

  it('waits longer than CI takes, and the job outlives the wait with room to deploy', () => {
    // The last 30 green CI runs took 22–77 min (2026-10-01).
    const waitS = envValue(gate, 'WAIT_SECONDS');
    expect(waitS).toBeGreaterThanOrEqual(77 * 60);
    const m = deploy.match(/\n {2}deploy:[\s\S]*?timeout-minutes: (\d+)/);
    expect(m, 'no timeout-minutes for job deploy').not.toBeNull();
    expect(Number(m![1]) * 60).toBeGreaterThanOrEqual(waitS + 15 * 60);
  });

  it('reads the LATEST CI run for the sha, so a label run supersedes the push run', () => {
    expect(runBlock(gate)).toMatch(/gh run list .*--workflow 'CI' --commit "\$1" \\\n\s+--limit 1 /);
  });
});

// Every case here spawns bash (one to six times), which a loaded full-suite run
// slows past vitest's 5 s default; alone they take 0.3-3.6 s.
describe('deploy-production.yml: the CI gate itself (behaviour, under bash, stub gh)', { timeout: 60_000 }, () => {
  const gate = gateStep();
  const script = runBlock(gate);
  const root = mkdtempSync(path.join(tmpdir(), 'deploy-gate-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const MERGE = 'a'.repeat(40);
  const HEAD = 'b'.repeat(40);
  const FAST = { WAIT_SECONDS: '1', POLL_SECONDS: '0.2' };

  let n = 0;
  /**
   * `runs[sha]`: what CI looks like for that sha at each successive
   * `gh run list` call, the last repeated. Each entry is the runs listed for
   * the sha NEWEST FIRST as "status/conclusion"; `[]` is no run at all, and
   * `'!'` makes that call fail as an API error would. The stub refuses a query
   * without `--limit 1`, so it prints exactly what the real one would.
   * `pulls[sha]`: the PR head sha `commits/{sha}/pulls` resolves to.
   */
  function run(
    runs: Record<string, (string[] | '!')[]>,
    pulls: Record<string, string> = {},
    env: Record<string, string> = {}
  ) {
    const dir = path.join(root, `stub-${n++}`);
    mkdirSync(dir);
    for (const [sha, ticks] of Object.entries(runs)) {
      writeFileSync(
        path.join(dir, `runs-${sha}`),
        ticks.map((t) => (t === '!' ? '!' : t.join(' '))).join('\n---\n') + '\n'
      );
    }
    for (const [sha, head] of Object.entries(pulls)) writeFileSync(path.join(dir, `pulls-${sha}`), head);
    writeFileSync(
      path.join(dir, 'gh'),
      [
        '#!/usr/bin/env bash',
        `d='${dir}'`,
        'printf "%s\\n" "$*" >> "$d/args"',
        'case "$*" in',
        '  run\\ list*--commit*)',
        '    [[ "$*" == *"--limit 1 "* ]] || { echo "gate must ask for the latest run only" >&2; exit 2; }',
        '    sha=$(printf "%s\\n" "$*" | sed -E "s/.*--commit ([^ ]+).*/\\1/")',
        '    c=$(( $(cat "$d/n-$sha" 2>/dev/null || echo 0) + 1 )); echo $c > "$d/n-$sha"',
        '    echo x >> "$d/calls"',
        '    [ -f "$d/runs-$sha" ] || { echo none; exit 0; }',
        '    total=$(( $(grep -c "^---$" "$d/runs-$sha") + 1 ))',
        '    out=$(awk -v k=$(( c < total ? c : total )) \'BEGIN{b=1} /^---$/{b++; next} b==k\' "$d/runs-$sha")',
        '    [ "$out" = "!" ] && exit 1',
        '    set -- $out; [ -n "${1:-}" ] && echo "$1" || echo none ;;',
        '  api\\ repos/*/commits/*/pulls*)',
        '    sha=$(printf "%s\\n" "$1 $2" | sed -E "s#.*/commits/([^/]+)/pulls.*#\\1#")',
        '    [ -f "$d/pulls-$sha" ] && cat "$d/pulls-$sha"; exit 0 ;;',
        '  *) echo "unexpected gh call: $*" >&2; exit 2 ;;',
        'esac',
      ].join('\n')
    );
    writeFileSync(path.join(dir, 'git'), `#!/usr/bin/env bash\n[ "$*" = "rev-parse HEAD" ] && echo ${MERGE} && exit 0\nexit 2\n`);
    chmodSync(path.join(dir, 'gh'), 0o755);
    chmodSync(path.join(dir, 'git'), 0o755);
    const summary = path.join(dir, 'summary');
    const started = Date.now();
    const r = spawnSync('bash', ['-c', script], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 20_000,
      env: {
        NODE_ENV: 'test',
        PATH: `${dir}:${process.env.PATH}`,
        HOME: process.env.HOME,
        GITHUB_REPOSITORY: 'samuelshirley/FeralTravels',
        GITHUB_RUN_ID: '36856433646',
        GITHUB_STEP_SUMMARY: summary,
        GH_TOKEN: 'stub',
        WAIT_SECONDS: '600',
        POLL_SECONDS: '0',
        LOG_EVERY_SECONDS: '300',
        ...env,
      },
    });
    const calls = existsSync(path.join(dir, 'calls'))
      ? readFileSync(path.join(dir, 'calls'), 'utf8').trim().split('\n').length
      : 0;
    return {
      code: r.status,
      out: r.stdout + r.stderr,
      calls,
      ms: Date.now() - started,
      args: readFileSync(path.join(dir, 'args'), 'utf8'),
      summary: existsSync(summary) ? readFileSync(summary, 'utf8') : '',
    };
  }

  it('(a) waits through queued and in_progress, then deploys on success', () => {
    const r = run({ [MERGE]: [['queued/pending'], ['in_progress/pending'], ['in_progress/pending'], ['completed/success']] });
    expect(r.out).not.toContain('::error::');
    expect(r.code).toBe(0);
    expect(r.calls).toBe(4);
    expect(r.summary).toContain(`CI green for ${MERGE}`);
  });

  it('(b) a run that ends in failure fails the deploy, saying so and how to recover', () => {
    const r = run({ [MERGE]: [['in_progress/pending'], ['completed/failure']] });
    expect(r.code).toBe(1);
    expect(r.out).toContain(`::error::CI for ${MERGE} concluded failure, not success.`);
    expect(r.out).toContain('Production was NOT updated');
    expect(r.out).toContain('gh run rerun 36856433646');
    expect(r.summary).toBe('');
  });

  it('(b) so does any other conclusion, already final when the gate first looks', () => {
    for (const c of ['failure', 'cancelled', 'timed_out', 'skipped', 'startup_failure', 'action_required']) {
      const r = run({ [MERGE]: [[`completed/${c}`]] });
      expect(r.code, c).toBe(1);
      expect(r.calls, c).toBe(1);
      expect(r.out, c).toContain(`concluded ${c}, not success`);
    }
  });

  it('(c) a run that never completes fails at the ceiling, not silently and not as a pass', () => {
    const r = run({ [MERGE]: [['in_progress/pending']] }, {}, FAST);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(new RegExp(`::error::Gave up after \\d+s waiting for CI on ${MERGE} \\(last state: in_progress/pending\\)`));
    expect(r.out).toContain('Production was NOT updated');
    expect(r.calls).toBeGreaterThan(1);
  });

  it('(d) no run for the commit nor a PR head fails at once, without waiting', () => {
    const r = run({}, {}, { POLL_SECONDS: '5' });
    expect(r.code).toBe(1);
    expect(r.calls).toBe(1);
    expect(r.ms).toBeLessThan(4000);
    expect(r.out).toContain(`::error::No CI run exists for ${MERGE}`);
    expect(r.out).toContain('Production was NOT updated');
  });

  it('(d) nor does a PR head with no CI run of its own', () => {
    const r = run({}, { [MERGE]: HEAD }, { POLL_SECONDS: '5' });
    expect(r.code).toBe(1);
    expect(r.calls).toBe(2);
    expect(r.ms).toBeLessThan(4000);
    expect(r.out).toContain('::error::No CI run exists');
  });

  it('(e) a merge commit resolves to its PR head, whose green run deploys', () => {
    const r = run({ [HEAD]: [['completed/success']] }, { [MERGE]: HEAD });
    expect(r.code).toBe(0);
    expect(r.out).toContain(`Commit came from PR head: ${HEAD}`);
    expect(r.args).toContain(`--commit ${HEAD}`);
    expect(r.summary).toContain(`CI green for ${HEAD}`);
  });

  it('(e) ...and waits on the PR head\'s run, not the merge commit', () => {
    const r = run({ [HEAD]: [['in_progress/pending'], ['completed/success']] }, { [MERGE]: HEAD });
    expect(r.code).toBe(0);
    expect(r.args.trim().split('\n').at(-1)).toContain(`--commit ${HEAD}`);
  });

  it('(f) PR #79: a newer run for the sha appears while waiting — the gate follows the newest', () => {
    // The push run is in progress; the `ai-tests` label starts a newer one and
    // CI's concurrency group cancels the old. Only the newest decides.
    const f = run(
      {
        [HEAD]: [
          ['in_progress/pending'],
          ['in_progress/pending', 'completed/cancelled'],
          ['in_progress/pending', 'completed/cancelled'],
          ['completed/success', 'completed/cancelled'],
        ],
      },
      { [MERGE]: HEAD }
    );
    expect(f.out).not.toContain('::error::');
    expect(f.code).toBe(0);
    expect(f.calls).toBe(5);
  });

  it('(f) ...and a newer run that fails is not rescued by the older one passing', () => {
    const r = run(
      { [HEAD]: [['in_progress/pending', 'completed/success'], ['completed/failure', 'completed/success']] },
      { [MERGE]: HEAD }
    );
    expect(r.code).toBe(1);
    expect(r.out).toContain('concluded failure');
  });

  it('an API error while waiting is retried, never taken as a pass', () => {
    const ok = run({ [MERGE]: [['in_progress/pending'], '!', ['completed/success']] });
    expect(ok.code).toBe(0);
    const dead = run({ [MERGE]: [['in_progress/pending'], '!'] }, {}, FAST);
    expect(dead.code).toBe(1);
    expect(dead.out).toContain('last state: api-error');
  });

  it('logs on a state change, not on every poll', () => {
    const r = run({ [MERGE]: [...Array(6).fill(['in_progress/pending']), ['completed/success']] });
    expect(r.code).toBe(0);
    expect(r.out.match(/in_progress\/pending/g)).toHaveLength(1);
    expect(r.out).toContain('completed/success');
  });
});
