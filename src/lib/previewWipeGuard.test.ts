import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PREVIEW_BRANCH_RE, previewWipeRefusal } from './columnCoverage';

/**
 * No customer data on a PR preview (Sam, 2026-09-30/10-01).
 *
 * ci.yml's preview job clones PROD into `preview/pr-<N>` so the migration
 * rehearsal runs against real rows, then points two PUBLIC Vercel previews,
 * running unreviewed code with /api/test/* armed, at that branch. So the
 * branch is emptied in between: copy → migrate → wipe → deploy. This guard
 * holds the order and the fail-closed shape, because every one of these is a
 * one-line edit that would put real users' rows back behind a public URL
 * without turning anything red:
 *
 *  - the wipe step goes missing, or moves after a `vercel deploy`, or before
 *    the migration (the rehearsal would then run on an empty database);
 *  - it gains `continue-on-error` or an `if:`, so a failed wipe deploys anyway;
 *  - a deploy step gains an `if:` that runs after a failure (`always()`);
 *  - the confirm variable stops being wired, so the script refuses every run
 *    (red, but on every PR) — or is wired to something that is not the branch.
 *
 * ci.yml's layout is regular (jobs at 2 spaces, steps at 6), so a few lines of
 * text reading do; the same approach as ciFailFast.test.ts.
 */

const ROOT = path.resolve(__dirname, '../..');
const CI = readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');

type Step = { text: string; name: string };

/** The steps of one job, comments dropped, in order. */
function jobSteps(src: string, jobId: string): Step[] {
  const lines = src.split('\n');
  const start = lines.findIndex((l) => l === `  ${jobId}:`);
  if (start < 0) return [];
  const steps: Step[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trimStart().startsWith('#')) continue;
    if (/^ {2}\S/.test(line) || /^\S/.test(line)) break; // next job, or next top-level key
    if (/^ {6}- /.test(line)) steps.push({ text: '', name: '' });
    const step = steps.at(-1);
    if (!step) continue;
    step.text += `${line}\n`;
    const name = line.match(/^ {6}(?:- | {2})name: (.*)$/);
    if (name) step.name = name[1].trim();
  }
  return steps;
}

const WIPE_RUN = 'run: npx tsx scripts/wipe-preview-db.ts';
const isMigrate = (s: Step) => /run: npm run db:migrate\b/.test(s.text);
const isWipe = (s: Step) => s.text.includes(WIPE_RUN);
const isDeploy = (s: Step) => /\bvercel deploy\b/.test(s.text);
const isCreateBranch = (s: Step) => s.text.includes('uses: neondatabase/create-branch-action');
const field = (s: Step, key: string) => s.text.match(new RegExp(`^ {6}(?:- | {2})${key}:\\s*(.*)$`, 'm'))?.[1];
const envVar = (s: Step, key: string) => s.text.match(new RegExp(`^ {10}${key}:\\s*(.*)$`, 'm'))?.[1];

/** Everything wrong with the preview job's wipe, one line each; [] when sound. */
function wipeProblems(src: string): string[] {
  const steps = jobSteps(src, 'preview');
  if (steps.length === 0) return ['ci.yml has no preview job'];
  const problems: string[] = [];
  const wipes = steps.map((s, i) => (isWipe(s) ? i : -1)).filter((i) => i >= 0);
  if (wipes.length !== 1) return [`the preview job has ${wipes.length} wipe steps, needs exactly 1`];
  const wipe = wipes[0];
  const create = steps.findIndex(isCreateBranch);
  const migrate = steps.findIndex(isMigrate);
  const firstDeploy = steps.findIndex(isDeploy);
  if (create < 0 || migrate < 0) problems.push('the preview job lost its branch-create or migrate step');
  if (migrate > wipe) problems.push('the wipe runs before the migration rehearsal');
  if (firstDeploy < 0) problems.push('the preview job has no vercel deploy step (the check would prove nothing)');
  else if (firstDeploy < wipe) problems.push('a vercel deploy runs before the wipe');

  const w = steps[wipe];
  if (field(w, 'continue-on-error') !== undefined) problems.push('the wipe step has continue-on-error');
  if (field(w, 'if') !== undefined) problems.push('the wipe step has an if:');
  if (envVar(w, 'PREVIEW_DB_WIPE_CONFIRM') !== '${{ env.NEON_BRANCH }}') {
    problems.push('PREVIEW_DB_WIPE_CONFIRM is not wired to env.NEON_BRANCH');
  }
  if (envVar(w, 'DATABASE_URL') !== '${{ steps.neon.outputs.db_url }}') {
    problems.push('the wipe does not target the branch this job created');
  }
  for (const s of steps.slice(wipe + 1).filter(isDeploy)) {
    const cond = field(s, 'if');
    if (cond !== undefined && /always\(\)|failure\(\)|cancelled\(\)/.test(cond)) {
      problems.push(`"${s.name}" can deploy after a failed wipe (if: ${cond})`);
    }
    if (field(s, 'continue-on-error') !== undefined) problems.push(`"${s.name}" has continue-on-error`);
  }
  if (!/^ {2}NEON_BRANCH: preview\/pr-\$\{\{ github\.event\.pull_request\.number \}\}$/m.test(src)) {
    problems.push('the workflow-level NEON_BRANCH is no longer preview/pr-<N>');
  }
  return problems;
}

describe('ci.yml empties the preview database before anything deploys', () => {
  it('the parser sees the preview job (so the checks below are not passing on nothing)', () => {
    const steps = jobSteps(CI, 'preview');
    expect(steps.length).toBeGreaterThan(5);
    expect(steps.some(isCreateBranch)).toBe(true);
    expect(steps.some(isMigrate)).toBe(true);
    expect(steps.filter(isDeploy)).toHaveLength(1);
  });

  it('copy → migrate → wipe → deploy, fail closed, confirm wired', () => {
    expect(wipeProblems(CI)).toEqual([]);
  });

  it('the sticky preview comment no longer calls it a clone of production', () => {
    expect(CI).not.toMatch(/Fresh clone of the production database/);
    expect(CI).toMatch(/fixture data only, no customer data/);
  });

  describe('the check itself catches', () => {
    const wipeStep = jobSteps(CI, 'preview').find(isWipe)?.text ?? '';
    const without = (src: string) => src.replace(wipeStep, '');

    it('the wipe step removed', () => {
      expect(wipeStep).not.toBe('');
      expect(wipeProblems(without(CI))).toEqual(['the preview job has 0 wipe steps, needs exactly 1']);
    });

    it('the wipe moved after the deploy', () => {
      const moved = without(CI).replace('      - name: Publish the preview URL on the PR\n', `${wipeStep}      - name: Publish the preview URL on the PR\n`);
      expect(moved).not.toBe(without(CI));
      expect(wipeProblems(moved)).toEqual(['a vercel deploy runs before the wipe']);
    });

    it('the wipe moved before the migration', () => {
      const moved = without(CI).replace('      - name: Apply migrations to the PR branch\n', `${wipeStep}      - name: Apply migrations to the PR branch\n`);
      expect(moved).not.toBe(without(CI));
      expect(wipeProblems(moved)).toEqual(['the wipe runs before the migration rehearsal']);
    });

    it('continue-on-error, or an if:, on the wipe', () => {
      const soft = CI.replace(wipeStep, wipeStep.replace('        env:\n', '        continue-on-error: true\n        env:\n'));
      expect(wipeProblems(soft)).toEqual(['the wipe step has continue-on-error']);
      const iffy = CI.replace(wipeStep, wipeStep.replace('        env:\n', "        if: github.event.action != 'labeled'\n        env:\n"));
      expect(wipeProblems(iffy)).toEqual(['the wipe step has an if:']);
    });

    it('the confirm variable unwired, or pointed elsewhere', () => {
      const gone = CI.replace('          PREVIEW_DB_WIPE_CONFIRM: ${{ env.NEON_BRANCH }}\n', '');
      expect(wipeProblems(gone)).toEqual(['PREVIEW_DB_WIPE_CONFIRM is not wired to env.NEON_BRANCH']);
      const hard = CI.replace('PREVIEW_DB_WIPE_CONFIRM: ${{ env.NEON_BRANCH }}', "PREVIEW_DB_WIPE_CONFIRM: 'preview/pr-1'");
      expect(wipeProblems(hard)).toEqual(['PREVIEW_DB_WIPE_CONFIRM is not wired to env.NEON_BRANCH']);
    });

    it('a deploy that runs after a failure', () => {
      const always = CI.replace('        id: deploy\n', '        id: deploy\n        if: always()\n');
      expect(always).not.toBe(CI);
      expect(wipeProblems(always)).toEqual(['"Deploy preview + print URL" can deploy after a failed wipe (if: always())']);
    });
  });
});

describe('the wipe refuses anything but a PR preview branch', () => {
  const ok = { neonBranch: 'preview/pr-84', confirm: 'preview/pr-84' };

  it('runs on preview/pr-<N> when both variables agree', () => {
    expect(previewWipeRefusal(ok)).toBeNull();
    expect(PREVIEW_BRANCH_RE.test('preview/pr-1')).toBe(true);
  });

  it.each([
    ['nothing set (a developer shell)', {}],
    ['empty strings', { neonBranch: '', confirm: '' }],
    ['confirm only', { confirm: 'preview/pr-84' }],
    ['branch only', { neonBranch: 'preview/pr-84' }],
    ['the two disagree', { neonBranch: 'preview/pr-84', confirm: 'preview/pr-85' }],
    ['main', { neonBranch: 'main', confirm: 'main' }],
    ['production', { neonBranch: 'production', confirm: 'production' }],
    ['prod', { neonBranch: 'prod', confirm: 'prod' }],
    ['a preview with no number', { neonBranch: 'preview/pr-', confirm: 'preview/pr-' }],
    ['pr-0', { neonBranch: 'preview/pr-0', confirm: 'preview/pr-0' }],
    ['a suffix', { neonBranch: 'preview/pr-84-main', confirm: 'preview/pr-84-main' }],
    ['a prefix', { neonBranch: 'x/preview/pr-84', confirm: 'x/preview/pr-84' }],
    ['another kind of branch', { neonBranch: 'dev/sam', confirm: 'dev/sam' }],
    ['an unexpanded expression', { neonBranch: 'preview/pr-${{ x }}', confirm: 'preview/pr-${{ x }}' }],
  ])('refuses: %s', (_label, env) => {
    expect(previewWipeRefusal(env)).not.toBeNull();
  });
});
