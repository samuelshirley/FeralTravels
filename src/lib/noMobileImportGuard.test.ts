/**
 * Architectural guardrail: nothing under `src/` may import from `mobile/`.
 *
 * THE FAILURE THIS EXISTS TO PREVENT, because it cost a red PR and was
 * invisible on every developer machine:
 *
 * A component test reached across into `mobile/lib/entitlement.ts` to exercise
 * the real shipped function rather than a copy. It used a non-literal
 * specifier specifically to keep that file out of the root tsconfig's type
 * graph, and that worked — `next build` stayed green.
 *
 * It dodged the type graph and not the BUILD graph. Vitest still transforms
 * whatever it imports; `mobile/tsconfig.json` extends `expo/tsconfig.base`;
 * and CI's unit job runs `npm ci` at the ROOT only, so `mobile/node_modules`
 * does not exist there. The transform failed with "Failed to load tsconfig
 * 'expo/tsconfig.base': Tsconfig not found" and the whole file errored out.
 *
 * Locally it passed, because a developer machine has both trees installed.
 * That asymmetry is the entire problem: the suite was green everywhere a human
 * would look and red in the one place that gates the merge.
 *
 * The supported route for logic both clients need is `src/lib/` plus a mapping
 * in `scripts/sync-shared.mjs`, which mirrors it into `mobile/shared/` and is
 * itself guarded against drift by `sharedMirror.test.ts`.
 *
 * READING a mobile file as TEXT is still fine and deliberately not caught
 * here — `readFileSync('mobile/components/ChatPanel.tsx')` is how several
 * specs assert the native panel still calls what it should. Text is not a
 * module; nothing transforms it.
 */
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const SRC = path.resolve(__dirname, '..');
const SCAN = new Set(['.ts', '.tsx']);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (SCAN.has(path.extname(entry.name))) out.push(full);
  }
  return out;
}

/**
 * Matches a module specifier pointing into `mobile/`, whether written as a
 * static import, a dynamic one, or assigned to a constant first — that last
 * form is the one that actually shipped, so a regex that only caught
 * `from '...'` would have missed it.
 */
const MOBILE_SPECIFIER = /(?:from\s*|import\s*\(\s*|=\s*)['"][^'"]*(?:\.\.\/)+mobile\/[^'"]*['"]/;

describe('src/ never imports from mobile/', () => {
  const files = sourceFiles(SRC);

  it('finds source files to scan', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  for (const file of files) {
    const rel = path.relative(SRC, file).split(path.sep).join('/');
    const content = fs.readFileSync(file, 'utf-8');
    const match = content.match(MOBILE_SPECIFIER);
    if (!match) continue;

    it(`src/${rel} must not reach into mobile/`, () => {
      const line = content.slice(0, match.index).split('\n').length;
      expect.fail(
        `src/${rel}:${line} references a module under mobile/:\n` +
          `  ${match[0]}\n\n` +
          `  The root unit suite installs only the root node_modules, so anything\n` +
          `  under mobile/ fails to transform in CI while passing locally.\n` +
          `  Move the shared logic to src/lib/ and add it to SHARED_FILES in\n` +
          `  scripts/sync-shared.mjs instead.`
      );
    });
  }
});
