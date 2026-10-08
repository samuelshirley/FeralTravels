import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * `src/server/jev/` is a bounded module. Decision I22. Copied from
 * `paymentsBoundaryGuard.test.ts`, and tighter.
 *
 * Jev is pointed at chat messages on a server Sam runs, with a threshold
 * tuned for ONE question: may this message through? The property worth
 * guarding is that exactly one place in the app can ask it anything — the
 * message gate — so that nobody wires Jev into Penny's planning loop or the
 * replan route "because it is already there", where a wrong answer is not
 * caught by Haiku and the privacy page does not cover it.
 *
 * So: only the gate, its repo, the admin routes and scripts may import
 * `@/server/jev`, and NOTHING outside the module may reach past `index.ts`.
 */

const ROOT = join(__dirname, '..', '..');
const MODULE_DIR = 'src/server/jev';

/** Who may import the public surface. */
const ALLOWED = [
  'src/server/messageGate.ts',
  'src/server/repos/jev.ts',
];
const ALLOWED_PREFIXES = ['src/app/api/admin/jev/', 'scripts/'];

/** Guards and tests read the module to test it. */
const isTest = (f: string) => /\.test\.tsx?$/.test(f);

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
    else if (/\.(tsx?|mjs)$/.test(name)) out.push(p);
  }
  return out;
}

const files = [...walk(join(ROOT, 'src')), ...walk(join(ROOT, 'scripts'))]
  .map((f) => relative(ROOT, f).split('\\').join('/'))
  .filter((f) => !f.startsWith(MODULE_DIR + '/'))
  .filter((f) => !isTest(f));

/** Every module specifier in a file: static, re-export, and dynamic `import()`. */
function specifiers(src: string): string[] {
  const re = /(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)['"]([^'"]+)['"]/gm;
  return [...src.matchAll(re)].map((m) => m[1]);
}

/** What a specifier in `file` points at, as a repo path — or null for a package. */
function target(file: string, spec: string): string | null {
  if (spec.startsWith('@/')) return 'src/' + spec.slice(2);
  if (spec.startsWith('.')) return normalize(join(dirname(file), spec)).split('\\').join('/');
  return null;
}

/** 'public' for the index, 'internal' for anything under it, null otherwise. */
function jevImport(file: string): 'public' | 'internal' | null {
  let found: 'public' | 'internal' | null = null;
  for (const spec of specifiers(readFileSync(join(ROOT, file), 'utf8'))) {
    const t = target(file, spec);
    if (t === null) continue;
    if (t === MODULE_DIR || t === `${MODULE_DIR}/index`) found = found ?? 'public';
    else if (t.startsWith(MODULE_DIR + '/')) found = 'internal';
  }
  return found;
}

describe('nothing outside the gate asks Jev anything', () => {
  it('finds the allowed importers (the guard is not vacuous)', () => {
    for (const f of ALLOWED) {
      expect(jevImport(f), f).toBe('public');
    }
  });

  it('only the gate, its repo, the admin routes and scripts import @/server/jev', () => {
    const hits = files.filter((f) => {
      if (ALLOWED.includes(f) || ALLOWED_PREFIXES.some((p) => f.startsWith(p))) return false;
      return jevImport(f) !== null;
    });
    expect(hits, 'Jev answers the message gate and nothing else. See docs/design/jev.md.').toEqual([]);
  });

  it('Penny and the replan route never import it, allowed list or not', () => {
    for (const f of ['src/lib/claude.ts', 'src/app/api/trip/replan/route.ts']) {
      expect(jevImport(f), f).toBeNull();
    }
  });

  it('nobody reaches past index.ts', () => {
    const hits = files.filter((f) => jevImport(f) === 'internal');
    expect(hits, "Import from '@/server/jev' (the index), not its internals.").toEqual([]);
  });

  it('resolves relative and aliased paths, and does not confuse repos/jev with server/jev', () => {
    expect(target('src/server/messageGate.ts', './jev')).toBe('src/server/jev');
    expect(target('src/server/repos/admin.ts', './jev')).toBe('src/server/repos/jev');
    expect(target('src/app/x.ts', '@/server/jev/client')).toBe('src/server/jev/client');
    expect(specifiers("export { a } from '@/server/jev';\nconst m = await import('../jev/config');")).toEqual([
      '@/server/jev',
      '../jev/config',
    ]);
  });

  it('the module still exposes the one question', () => {
    const index = readFileSync(join(ROOT, MODULE_DIR, 'index.ts'), 'utf8');
    expect(index).toMatch(/export async function jevClassifyTier\(/);
  });
});
