/**
 * The guard for scripts/decide-docs-only.mjs and the `decide` job it feeds —
 * the "should this PR run the expensive half of CI" call.
 *
 * THE ASYMMETRY THE ASSERTIONS ENCODE. Merging is deploying: a green CI run on
 * a PR's head sha is the whole of what deploy-production.yml checks before it
 * migrates the production database and ships. So a wrong `false` costs one
 * preview deploy, and a wrong `true` ships untested code to production with no
 * human in the way. Every uncertain case below therefore asserts `false`.
 *
 * TWO THINGS HERE ARE NOT ABOUT THE SCRIPT AT ALL, and they are the reason
 * this file reads ci.yml as text:
 *
 *  1. `unit` must stay ungated. Markdown in this repo is NOT inert —
 *     claudeMdGuard, decisionsRegisterGuard, removedFeaturesGuard,
 *     googleAccountingGuard and oneGoogleKeyGuard read CLAUDE.md and
 *     docs/decisions.md as text and fail on drift, which makes a docs-only PR
 *     exactly the kind that reds them. Gating `unit` on docs_only would turn
 *     the one job that can catch a docs bug off for docs changes.
 *
 *  2. The trigger must stay unfiltered. A `paths-ignore` looks like the
 *     obvious implementation and is the trap: it produces NO CI run for the
 *     PR's head sha, `deploy-production.yml`'s `gh run list --workflow CI
 *     --commit <sha>` reads "none", and the docs merge leaves production stale
 *     until somebody re-runs the deploy by hand. Skipped jobs still let the
 *     run conclude `success`, which is what the gate reads.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
// Plain ESM JS with no declarations — same arrangement as
// decideMobileRelease.test.ts, which imports its script the same way.
import { decideDocsOnly as decideRaw } from '../../scripts/decide-docs-only.mjs';

const decideDocsOnly = decideRaw as (files: string[]) => {
  docsOnly: boolean;
  reasons: string[];
};

const ROOT = path.resolve(__dirname, '../..');
const ci = readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');

describe('decideDocsOnly', () => {
  it('is true for markdown anywhere in the tree', () => {
    expect(
      decideDocsOnly(['CLAUDE.md', 'docs/decisions.md', 'mobile/README.md']).docsOnly
    ).toBe(true);
  });

  it('is true for anything under docs/, markdown or not', () => {
    expect(decideDocsOnly(['docs/design/diagram.png', 'docs/tasks/brief.md']).docsOnly).toBe(true);
  });

  it('is false as soon as one code file rides along', () => {
    expect(decideDocsOnly(['docs/decisions.md', 'src/lib/units.ts']).docsOnly).toBe(false);
  });

  it('names the offending files, so the run log says why it ran everything', () => {
    const { reasons } = decideDocsOnly(['README.md', 'src/server/fuel.ts']);
    expect(reasons.join('\n')).toContain('src/server/fuel.ts');
  });

  /**
   * A workflow edit is code. This file is the thing that decides what runs, so
   * a change to it skipping its own verification is the worst possible case.
   */
  it('is false for a workflow change, even one that only touches comments', () => {
    expect(decideDocsOnly(['.github/workflows/ci.yml']).docsOnly).toBe(false);
    expect(decideDocsOnly(['scripts/decide-docs-only.mjs']).docsOnly).toBe(false);
  });

  it('is false for a test that happens to live beside docs', () => {
    expect(decideDocsOnly(['src/lib/claudeMdGuard.test.ts']).docsOnly).toBe(false);
  });

  // ── fail-safe direction ──────────────────────────────────────────────────

  it('is false when the diff is empty — an unreadable API answer is not proof', () => {
    expect(decideDocsOnly([]).docsOnly).toBe(false);
    expect(decideDocsOnly(['', '  ', '\n']).docsOnly).toBe(false);
  });

  it('is false for a file type invented tomorrow', () => {
    expect(decideDocsOnly(['docs.txt']).docsOnly).toBe(false);
    expect(decideDocsOnly(['notes.rst']).docsOnly).toBe(false);
    // `documentation/` is not `docs/`; the prefix is exact on purpose.
    expect(decideDocsOnly(['documentation/guide.md']).docsOnly).toBe(true); // ends in .md
    expect(decideDocsOnly(['documentation/logo.svg']).docsOnly).toBe(false);
  });
});

describe('the CI workflow is wired to it', () => {
  it('has a decide job that runs the script', () => {
    expect(ci).toMatch(/^ {2}decide:/m);
    expect(ci).toContain('node scripts/decide-docs-only.mjs');
    expect(ci).toContain('docs_only: ${{ steps.scope.outputs.docs_only }}');
  });

  it('gates the preview and the mobile typecheck on it', () => {
    const gate = /if: needs\.decide\.outputs\.docs_only != 'true'/g;
    expect(ci.match(gate)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(ci).toContain("needs: [unit, decide]");
  });

  /**
   * `e2e` and `ios-e2e` carry no gate of their own — they `needs: preview`, and
   * GitHub skips a job whose dependency skipped. If either is ever re-parented,
   * it needs the gate written out.
   */
  it('leaves e2e and ios-e2e depending on preview, which is what skips them', () => {
    expect(ci).toMatch(/ {2}e2e:\n(?: {4}.*\n)* {4}needs: preview/);
    expect(ci).toMatch(/ {2}ios-e2e:\n(?: {4}.*\n)* {4}needs: preview/);
  });

  it('does NOT gate the unit job — the docs guards live there', () => {
    const unitBlock = ci.slice(ci.indexOf('\n  unit:'), ci.indexOf('\n  mobile:'));
    expect(unitBlock).not.toContain('docs_only');
  });

  it('does NOT filter the trigger, which would starve the deploy gate', () => {
    const trigger = ci.slice(ci.indexOf('\non:'), ci.indexOf('\nconcurrency:'));
    expect(trigger).not.toContain('paths-ignore');
    expect(trigger).not.toContain('paths:');
  });
});
