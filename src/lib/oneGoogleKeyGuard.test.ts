import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * There is exactly ONE Google Maps API key. Decision H5.
 *
 * `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` serves the browser map AND every server-side
 * Google REST call. `GOOGLE_MAPS_SERVER_API_KEY` was dead scaffolding: the
 * variable is not set in Vercel, so the helper that read it always fell through
 * to the public key.
 *
 * This exists because CLAUDE.md records that the phantom second key has confused
 * past assistants "repeatedly" — someone reads the name, believes a server key
 * exists, and proposes "use the server key" as the fix for a permissions error.
 * The name being absent is what stops that.
 */

const ROOT = join(__dirname, '..', '..');
const DEAD = 'GOOGLE_MAPS_SERVER_API_KEY';

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const p = join(dir, name);
    if (name === 'node_modules' || name.startsWith('.')) continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx?|js|mjs)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

describe('one Google Maps key', () => {
  it('the dead server-key name appears nowhere in source', () => {
    const hits = [...walk(join(ROOT, 'src')), ...walk(join(ROOT, 'mobile'))]
      .filter((f) => !f.endsWith('oneGoogleKeyGuard.test.ts'))
      .filter((f) => readFileSync(f, 'utf8').includes(DEAD))
      .map((f) => relative(ROOT, f));
    expect(hits, `${DEAD} does not exist. There is one key: NEXT_PUBLIC_GOOGLE_MAPS_API_KEY.`)
      .toEqual([]);
  });

  it('nor in .env.example, which is where people copy names from', () => {
    const env = readFileSync(join(ROOT, '.env.example'), 'utf8');
    expect(env).not.toContain(DEAD);
    expect(env).toContain('NEXT_PUBLIC_GOOGLE_MAPS_API_KEY');
  });
});
