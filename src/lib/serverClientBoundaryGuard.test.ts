/**
 * A server module must never CALL a value imported from a `'use client'`
 * module.
 *
 * In the RSC graph every export of a `'use client'` module is compiled to a
 * client-reference proxy, not the value itself. Rendering such a module as a
 * component is the whole point and stays legal; *calling* one of its exports
 * on the server throws `TypeError: <name> is not a function` at render time.
 *
 * This is invisible to `tsc` — the types are correct, only the runtime binding
 * is wrong — and invisible to the component specs, which run everything as a
 * client. It is also invisible in `next dev` until the page is actually
 * requested, and the page here was one only the admin could reach.
 *
 * The incident: `buttonStyle` was a plain helper exported from
 * `components/ui/Button.tsx` (`'use client'`), and `app/settings/page.tsx` — a
 * server component — called it inside its admin-only block. `/settings` 500'd
 * with digest 1097810709 from 2026-09-03 (twelve minutes after `Button.tsx`
 * gained its directive) until 2026-09-08, and the only reason it took five
 * days to notice is that nobody but the admin can render that branch.
 *
 * The fix was structural — the helper moved to `components/ui/buttonStyle.ts`,
 * which carries no directive — and this is the guard that the class does not
 * come back somewhere else. Deliberately a call check and not an import check:
 * a server component importing a client COMPONENT is correct and ordinary.
 *
 * Mutation-checked: put `buttonStyle` back behind the client boundary and
 * import it into `settings/page.tsx`, and this test goes red naming that file.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, relative, dirname, resolve } from 'node:path';

const root = join(__dirname, '..', '..');
const srcDir = join(root, 'src');

/** Server-side roots. Everything under them runs on the server unless it says otherwise. */
const SERVER_ROOTS = [join(srcDir, 'app'), join(srcDir, 'server')];

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

/** The first meaningful line, so a file that opens with a licence comment still reads correctly. */
function isClientModule(file: string): boolean {
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('//') || line.startsWith('/*') || line.startsWith('*')) continue;
    return /^['"]use client['"];?$/.test(line);
  }
  return false;
}

function resolveSpecifier(fromFile: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith('@/')) base = join(srcDir, spec.slice(2));
  else if (spec.startsWith('.')) base = resolve(dirname(fromFile), spec);
  else return null; // a package, not ours
  for (const c of [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  return null;
}

interface Violation {
  file: string;
  name: string;
  from: string;
}

function findViolations(): Violation[] {
  const found: Violation[] = [];
  const clientCache = new Map<string, boolean>();

  for (const file of SERVER_ROOTS.flatMap((d) => walk(d))) {
    if (isClientModule(file)) continue; // it's a client component; the rule doesn't apply
    const text = readFileSync(file, 'utf8');

    // Spread dots are blanked first: the call check excludes member access
    // (`obj.name(`), and `...buttonStyle('secondary')` — the exact shape of the
    // incident — puts a `.` immediately before the name. Without this the guard
    // reads the real bug as a method call and passes. Found by mutation-checking.
    const callText = text.replace(/\.\.\./g, ' ');

    const importRe = /import\s+([^'"]+?)\s+from\s+['"]([^'"]+)['"]/g;
    for (const m of text.matchAll(importRe)) {
      const clause = m[1];
      const spec = m[2];
      if (/^\s*type\s/.test(clause)) continue; // `import type { X } from` — erased

      const target = resolveSpecifier(file, spec);
      if (!target) continue;
      if (!clientCache.has(target)) clientCache.set(target, isClientModule(target));
      if (!clientCache.get(target)) continue;

      // Every binding this file pulls in, default and named alike.
      const names: string[] = [];
      const defaultMatch = clause.match(/^\s*([A-Za-z_$][\w$]*)\s*(?:,|$)/);
      if (defaultMatch) names.push(defaultMatch[1]);
      const braced = clause.match(/\{([^}]*)\}/);
      if (braced) {
        for (const part of braced[1].split(',')) {
          const p = part.trim();
          if (!p || /^type\s/.test(p)) continue; // inline type import — erased
          names.push((p.split(/\s+as\s+/).pop() as string).trim());
        }
      }

      for (const name of names) {
        // Called as a function somewhere in this server module. `<Name />` and
        // `{Name}` do not match, which is the distinction that matters.
        const called = new RegExp(`(^|[^\\w$.])${name}\\s*\\(`).test(callText);
        if (called) found.push({ file: relative(root, file), name, from: relative(root, target) });
      }
    }
  }
  return found;
}

describe('server/client boundary', () => {
  it('finds server modules to check at all', () => {
    // Cheap self-check: if the walk silently returns nothing, the guard would
    // pass forever while checking nothing.
    const files = SERVER_ROOTS.flatMap((d) => walk(d));
    expect(files.length).toBeGreaterThan(20);
  });

  it('no server module calls a value imported from a "use client" module', () => {
    const violations = findViolations();
    const detail = violations
      .map((v) => `  ${v.file} calls ${v.name}() imported from ${v.from} ('use client')`)
      .join('\n');
    expect(
      violations,
      violations.length
        ? `A server module calls an export of a client module. In the RSC graph that ` +
            `binding is a client-reference proxy, so the call throws ` +
            `"TypeError: ${violations[0].name} is not a function" when the page renders. ` +
            `Move the value into a module with no 'use client' directive ` +
            `(see src/components/ui/buttonStyle.ts):\n${detail}`
        : '',
    ).toEqual([]);
  });
});
