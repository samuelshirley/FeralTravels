import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Haiku 5.5 takes no sampling parameters: "omit `temperature`, `top_p`, and
 * `top_k`" (platform.claude.com, Haiku 5.5 migration guide). Three extractors
 * sent `temperature: 0` on Haiku 4.5. The migration guide does not say whether
 * the API rejects or ignores the field, so the code stops sending it. Rejected
 * would be a 400 on every onboarding date, range estimate and intent scan, all
 * of which fail soft to "ask the user", so nothing would turn red.
 *
 * Text match on the source, like the other guards: any of the three keys in a
 * server-side file is a failure. Prose ("temperatures in °C") does not match,
 * because the pattern needs the key followed by a colon.
 */
const ROOTS = ['src/server', 'src/lib', 'src/app/api', 'scripts'];
const SAMPLING_KEY = /\b(temperature|top_p|top_k)\s*:/;

function* files(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* files(p);
    else if (/\.(ts|tsx|mjs)$/.test(name) && !/\.test\.tsx?$/.test(name)) yield p;
  }
}

describe('Anthropic calls send no sampling parameters', () => {
  it('no temperature / top_p / top_k key anywhere a request is built', () => {
    const repo = process.cwd();
    const hits: string[] = [];
    for (const root of ROOTS) {
      for (const f of files(join(repo, root))) {
        readFileSync(f, 'utf8')
          .split('\n')
          .forEach((line, i) => {
            if (SAMPLING_KEY.test(line)) hits.push(`${relative(repo, f)}:${i + 1}  ${line.trim()}`);
          });
      }
    }
    expect(hits).toEqual([]);
  });
});
