import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SQL, is } from 'drizzle-orm';
import { PgDialect, PgTable, getTableConfig } from 'drizzle-orm/pg-core';
import * as schema from './schema';

/**
 * schema.ts and the migrations must agree on which columns are GENERATED.
 *
 * The two build databases by different routes: production (and every fresh
 * local or iOS e2e database) was bootstrapped by `db:push` FROM schema.ts,
 * while CI previews and the deploy gate only ever apply migrations on top of
 * that. They drifted on `trips.trip_name_ci_key`: the baseline migration says
 * `GENERATED ALWAYS AS (lower(trim("name"))) STORED`, schema.ts said plain
 * `text`, so prod got a plain column nothing writes. It sat NULL on every row,
 * the unique (user_id, trip_name_ci_key) index never fired, and duplicate trip
 * names went unblocked for months. Migration 0044 fixed the column; this keeps
 * the two from disagreeing again, in either direction.
 *
 * The migrations are replayed in journal order as a tiny DDL interpreter that
 * tracks each (table, column)'s generation expression: CREATE TABLE and ADD
 * COLUMN define it, DROP COLUMN / DROP TABLE remove it, RENAME COLUMN moves it,
 * ALTER COLUMN … DROP EXPRESSION makes it plain. `IF NOT EXISTS` on a column or
 * table that is already there is a no-op, as in Postgres. Expressions compare
 * with quotes and whitespace stripped, lowercased.
 */

const DRIZZLE_DIR = join(process.cwd(), 'drizzle');

/** Split SQL into statements on `;`, skipping quotes, `$$` bodies and comments. */
function splitStatements(sqlText: string): string[] {
  const out: string[] = [];
  let cur = '';
  let i = 0;
  while (i < sqlText.length) {
    const c = sqlText[i];
    const two = sqlText.slice(i, i + 2);
    if (two === '--') {
      const nl = sqlText.indexOf('\n', i);
      i = nl === -1 ? sqlText.length : nl;
      cur += ' ';
      continue;
    }
    if (two === '/*') {
      const end = sqlText.indexOf('*/', i + 2);
      i = end === -1 ? sqlText.length : end + 2;
      cur += ' ';
      continue;
    }
    if (c === "'" || c === '"' || two === '$$') {
      const close = two === '$$' ? '$$' : c;
      const end = sqlText.indexOf(close, i + close.length);
      const stop = end === -1 ? sqlText.length : end + close.length;
      cur += sqlText.slice(i, stop);
      i = stop;
      continue;
    }
    if (c === ';') {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
      i++;
      continue;
    }
    cur += c;
    i++;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Split on commas that are not inside parentheses or quotes. */
function splitTopLevel(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = '';
  for (const c of s) {
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === "'" || c === '"') {
      quote = c;
    } else if (c === '(') {
      depth++;
    } else if (c === ')') {
      depth--;
    } else if (c === ',' && depth === 0) {
      parts.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

/** The balanced `( … )` starting at `open`, without the outer parens. */
function balancedParens(s: string, open: number): string {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')' && --depth === 0) return s.slice(open + 1, i);
  }
  throw new Error(`unbalanced parentheses in: ${s}`);
}

/** The generation expression of a column definition, or null if it is plain. */
function generationExpr(def: string): string | null {
  const m = /\bGENERATED\s+ALWAYS\s+AS\s*\(/i.exec(def);
  if (!m) return null;
  return balancedParens(def, m.index + m[0].length - 1);
}

function normaliseExpr(expr: string): string {
  return expr.replace(/["\s]/g, '').toLowerCase();
}

const IDENT = String.raw`(?:"[^"]+"|[A-Za-z_][\w$]*)`;
const QUALIFIED = String.raw`(?:${IDENT}\s*\.\s*)?(${IDENT})`;
const unquote = (id: string) => (id.startsWith('"') ? id.slice(1, -1) : id.toLowerCase());

/** table → column → generation expression (null = plain column). */
type Columns = Map<string, Map<string, string | null>>;

function apply(state: Columns, stmt: string): void {
  const create = new RegExp(String.raw`^CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?${QUALIFIED}\s*\(`, 'i').exec(stmt);
  if (create) {
    const table = unquote(create[2]);
    if (create[1] && state.has(table)) return;
    const cols = new Map<string, string | null>();
    for (const item of splitTopLevel(balancedParens(stmt, create[0].length - 1))) {
      const col = new RegExp(String.raw`^(${IDENT})\s`).exec(item);
      if (!col || /^(CONSTRAINT|PRIMARY|UNIQUE|FOREIGN|CHECK|EXCLUDE)\b/i.test(item)) continue;
      cols.set(unquote(col[1]), generationExpr(item));
    }
    state.set(table, cols);
    return;
  }

  const drop = new RegExp(String.raw`^DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(.+?)(?:\s+CASCADE|\s+RESTRICT)?$`, 'is').exec(stmt);
  if (drop) {
    for (const t of splitTopLevel(drop[1])) {
      const name = new RegExp(String.raw`^${QUALIFIED}$`).exec(t.trim());
      if (name) state.delete(unquote(name[1]));
    }
    return;
  }

  const alter = new RegExp(String.raw`^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?${QUALIFIED}\s+`, 'is').exec(stmt);
  if (!alter) return;
  const table = unquote(alter[1]);
  const cols = state.get(table) ?? new Map<string, string | null>();
  state.set(table, cols);
  const rest = stmt.slice(alter[0].length);

  const rename = new RegExp(String.raw`^RENAME\s+(?:COLUMN\s+)?(${IDENT})\s+TO\s+(${IDENT})`, 'i').exec(rest);
  if (rename) {
    const from = unquote(rename[1]);
    if (cols.has(from)) {
      cols.set(unquote(rename[2]), cols.get(from) ?? null);
      cols.delete(from);
    }
    return;
  }

  for (const action of splitTopLevel(rest)) {
    const add = new RegExp(String.raw`^ADD\s+(?:COLUMN\s+)?(IF\s+NOT\s+EXISTS\s+)?(${IDENT})\s+(.*)$`, 'is').exec(action);
    if (add && !/^ADD\s+(CONSTRAINT|PRIMARY|UNIQUE|FOREIGN|CHECK)\b/i.test(action)) {
      const col = unquote(add[2]);
      if (add[1] && cols.has(col)) continue;
      cols.set(col, generationExpr(add[3]));
      continue;
    }
    const dropCol = new RegExp(String.raw`^DROP\s+(?:COLUMN\s+)?(?:IF\s+EXISTS\s+)?(${IDENT})`, 'i').exec(action);
    if (dropCol && !/^DROP\s+CONSTRAINT\b/i.test(action)) {
      cols.delete(unquote(dropCol[1]));
      continue;
    }
    const dropExpr = new RegExp(String.raw`^ALTER\s+(?:COLUMN\s+)?(${IDENT})\s+DROP\s+EXPRESSION\b`, 'i').exec(action);
    if (dropExpr && cols.has(unquote(dropExpr[1]))) cols.set(unquote(dropExpr[1]), null);
  }
}

/** "table.column" → normalised expression, for every column the migrations leave generated. */
function generatedFromMigrations(files: { tag: string; sql: string }[]): Map<string, string> {
  const state: Columns = new Map();
  for (const f of files) for (const stmt of splitStatements(f.sql)) apply(state, stmt);
  const out = new Map<string, string>();
  for (const [table, cols] of state) {
    for (const [col, expr] of cols) if (expr !== null) out.set(`${table}.${col}`, normaliseExpr(expr));
  }
  return out;
}

function migrationFiles(): { tag: string; sql: string }[] {
  const journal = JSON.parse(readFileSync(join(DRIZZLE_DIR, 'meta', '_journal.json'), 'utf8')) as {
    entries: { idx: number; tag: string }[];
  };
  return [...journal.entries]
    .sort((a, b) => a.idx - b.idx)
    .map((e) => ({ tag: e.tag, sql: readFileSync(join(DRIZZLE_DIR, `${e.tag}.sql`), 'utf8') }));
}

/** "table.column" → normalised expression, for every column schema.ts declares generated. */
function generatedFromSchema(): Map<string, string> {
  const dialect = new PgDialect();
  const out = new Map<string, string>();
  for (const value of Object.values(schema)) {
    if (!is(value, PgTable)) continue;
    const config = getTableConfig(value);
    for (const col of config.columns) {
      const as = col.generated?.as;
      if (as === undefined) continue;
      const expr = is(as, SQL)
        ? dialect.sqlToQuery(as).sql
        : typeof as === 'function'
          ? dialect.sqlToQuery((as as () => SQL)()).sql
          : String(as);
      out.set(`${config.name}.${col.name}`, normaliseExpr(expr));
    }
  }
  return out;
}

describe('generated columns: schema.ts agrees with the migrations', () => {
  const fromMigrations = generatedFromMigrations(migrationFiles());
  const fromSchema = generatedFromSchema();

  it('the migrations leave trips.trip_name_ci_key generated (the parser sees it)', () => {
    expect(fromMigrations.get('trips.trip_name_ci_key')).toBe('lower(trim(name))');
  });

  it('every column the migrations leave generated is declared generated in schema.ts, with the same expression', () => {
    const mismatched = [...fromMigrations]
      .filter(([key, expr]) => fromSchema.get(key) !== expr)
      .map(([key, expr]) => `${key}: migrations say (${expr}), schema.ts says ${fromSchema.has(key) ? `(${fromSchema.get(key)})` : 'plain'}`);
    expect(
      mismatched,
      'db:push builds from schema.ts, so a generated column it does not declare becomes a plain column nothing writes. ' +
        'Add .generatedAlwaysAs(...) in src/server/db/schema.ts with the migration\'s expression.',
    ).toEqual([]);
  });

  it('every column schema.ts declares generated is generated by the migrations', () => {
    const missing = [...fromSchema]
      .filter(([key]) => !fromMigrations.has(key))
      .map(([key, expr]) => `${key}: schema.ts says (${expr}), migrations leave it plain or absent`);
    expect(
      missing,
      'Deployed databases only get what the migrations apply. Write a migration that makes the column generated.',
    ).toEqual([]);
  });
});

describe('the migration interpreter', () => {
  const run = (...sqls: string[]) =>
    generatedFromMigrations(sqls.map((sql, i) => ({ tag: String(i), sql })));

  it('reads a generated column from CREATE TABLE, through nested parens and schema prefixes', () => {
    expect(
      run(`CREATE TABLE IF NOT EXISTS "public"."t" ("id" uuid PRIMARY KEY, "k" text GENERATED ALWAYS AS (lower(trim("n"))) STORED, "n" text NOT NULL);`),
    ).toEqual(new Map([['t.k', 'lower(trim(n))']]));
  });

  it('a later DROP COLUMN removes it, and a later plain ADD COLUMN keeps it plain', () => {
    const create = `CREATE TABLE "t" ("k" text GENERATED ALWAYS AS (lower("n")) STORED);`;
    expect(run(create, `ALTER TABLE "t" DROP COLUMN IF EXISTS "k";`).size).toBe(0);
    expect(run(create, `ALTER TABLE "t" DROP COLUMN "k";--> statement-breakpoint\nALTER TABLE "t" ADD COLUMN "k" text;`).size).toBe(0);
  });

  it('ADD COLUMN IF NOT EXISTS on an existing column changes nothing', () => {
    expect(
      run(`CREATE TABLE "t" ("k" text);`, `ALTER TABLE "t" ADD COLUMN IF NOT EXISTS "k" text GENERATED ALWAYS AS (lower("n")) STORED;`).size,
    ).toBe(0);
  });

  it('follows RENAME COLUMN, DROP EXPRESSION and DROP TABLE', () => {
    const create = `CREATE TABLE "t" ("k" text GENERATED ALWAYS AS (lower("n")) STORED);`;
    expect([...run(create, `ALTER TABLE "t" RENAME COLUMN "k" TO "j";`).keys()]).toEqual(['t.j']);
    expect(run(create, `ALTER TABLE "t" ALTER COLUMN "k" DROP EXPRESSION;`).size).toBe(0);
    expect(run(create, `DROP TABLE "t" CASCADE;`).size).toBe(0);
  });

  it('ignores semicolons inside DO $$ … $$ bodies, strings and comments', () => {
    expect(
      run(`-- a; comment\nDO $$ BEGIN UPDATE t SET n = 'a;b'; END $$;\nALTER TABLE "t" ADD COLUMN "k" text GENERATED ALWAYS AS (lower("n")) STORED;`),
    ).toEqual(new Map([['t.k', 'lower(n)']]));
  });
});
