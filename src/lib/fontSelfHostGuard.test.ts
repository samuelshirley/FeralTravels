import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * No build fetches a font from Google.
 *
 * `next/font/google` downloads the font CSS from fonts.googleapis.com inside
 * `next build`. When the answer was not what its parser expected, the build
 * died with "An error occurred in `next/font`" (TypeError reading '1' of null
 * in loader.js) — five failed runs from 2026-09-23 to 2026-11-13, two of them
 * production deploys of main that left prod on the previous build. Inter is
 * now self-hosted from `@fontsource-variable/inter` (src/app/layout.tsx).
 *
 * The stack order is load-bearing too: Inter (Latin), then `'Inter Variable'`
 * (the other subsets), then the metric-matched `'Inter Fallback'`. Put Arial
 * anywhere before `'Inter Variable'` and every `ł`, `ř`, `ș` renders in Arial,
 * because Arial has them.
 */

const ROOT = path.join(__dirname, '..', '..');
const read = (p: string) => readFileSync(path.join(ROOT, p), 'utf8');

describe('fonts are self-hosted', () => {
  it('nothing imports next/font/google', () => {
    const hits = execSync('git ls-files --cached --others --exclude-standard -- src mobile', { cwd: ROOT, encoding: 'utf8' })
      .split('\n')
      .filter((f) => /\.(tsx?|jsx?|mjs)$/.test(f) && !f.endsWith('fontSelfHostGuard.test.ts'))
      .filter((f) => existsSync(path.join(ROOT, f)) && /from\s+['"]next\/font\/google['"]/.test(read(f)));
    expect(hits).toEqual([]);
  });

  const layout = read('src/app/layout.tsx');

  it('the root layout loads Inter from a file that is installed', () => {
    const src = layout.match(/localFont\(\{[\s\S]*?src:\s*'([^']+)'/)?.[1];
    expect(src).toMatch(/@fontsource-variable\/inter\/files\/inter-latin-wght-normal\.woff2$/);
    expect(existsSync(path.join(ROOT, 'src/app', src as string))).toBe(true);
    expect(layout).toContain("import '@fontsource-variable/inter/wght.css';");
  });

  it("falls back to 'Inter Variable' before any Arial, and Arial only via the metric-matched face", () => {
    expect(layout).toMatch(/adjustFontFallback:\s*false/);
    expect(layout).toMatch(/fallback:\s*\['Inter Variable',\s*'Inter Fallback'\]/);
    const css = read('src/app/globals.css');
    const face = css.match(/@font-face\s*\{[^}]*font-family:\s*'Inter Fallback'[^}]*\}/)?.[0] ?? '';
    expect(face).toContain("src: local('Arial')");
    expect(face).toMatch(/size-adjust:\s*107\.06%/);
  });
});
