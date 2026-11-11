import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * No indented JSON in src/.
 *
 * Penny's trip context went to Anthropic as `JSON.stringify(ctx, null, 2)` on
 * every turn until 2026-11-04. The indentation is whitespace the model does not
 * need and is paid for as input tokens: on the canonical trip
 * (`src/server/fixtures/canonicalTrip.ts`) it was 24% of the characters of the
 * legs. Every JSON string the server builds is either model input or a wire
 * payload, so neither wants it — the rule is the whole tree, not one file, so
 * the next prompt builder cannot reintroduce it somewhere new.
 *
 * Parsed, not grepped: any `JSON.stringify` CALL with a third argument (the
 * indent), found with the TypeScript parser so object literals and nested
 * calls cannot fool it. A page that pretty-prints for a human reader goes in
 * ALLOWED with the reason.
 */

const ROOT = join(__dirname, '..', '..');
const SRC = join(ROOT, 'src');

const ALLOWED: Record<string, string> = {
  'src/app/admin/chats/[tripId]/page.tsx':
    'renders a stored tool payload for Sam to read on /admin; never sent to a model',
};

/** Every `JSON.stringify(a, b, c)` call in `source`, as its text. */
function indentedCalls(source: string, fileName = 'x.ts'): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(sf) === 'JSON.stringify' &&
      node.arguments.length >= 3
    ) {
      out.push(node.getText(sf));
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === 'node_modules' || name === '__fixtures__') continue;
      walk(p, out);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}

describe('compact JSON for model input and the wire', () => {
  it('the parser catches the exact form that was removed, and not the compact one', () => {
    expect(indentedCalls('JSON.stringify(ctx, null, 2)')).toHaveLength(1);
    expect(indentedCalls("JSON.stringify(links, null, '\\t')")).toHaveLength(1);
    expect(indentedCalls('JSON.stringify(ctx)')).toEqual([]);
    expect(indentedCalls('JSON.stringify({ a: 1, b: f(x, y) })')).toEqual([]);
    expect(indentedCalls('JSON.stringify({ lat, lng, place_name: p })')).toEqual([]);
  });

  it('no non-test file under src/ indents JSON', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const rel = relative(ROOT, file);
      if (ALLOWED[rel]) continue;
      const hits = indentedCalls(readFileSync(file, 'utf8'), file);
      if (hits.length) offenders.push(`${rel}: ${hits.join(' | ')}`);
    }
    expect(offenders).toEqual([]);
  });
});
