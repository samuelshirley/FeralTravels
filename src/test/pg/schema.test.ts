import { describe, expect, it } from 'vitest';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import * as schema from '@/server/db/schema';
import { rawQuery } from './harness';

/**
 * The PGlite database the round-trip tests run against IS schema.ts: every
 * table, every FK's ON DELETE rule, every unique index and the generated
 * column, checked against Postgres's own catalog. If this file fails, the
 * other files in this folder are testing a different database from prod's.
 */

const tables = (Object.values(schema) as unknown[]).filter((v): v is PgTable => v instanceof PgTable);
const configs = tables.map((t) => getTableConfig(t));

const ACTION: Record<string, string> = {
  a: 'no action',
  r: 'restrict',
  c: 'cascade',
  n: 'set null',
  d: 'set default',
};

describe('the test database is built from schema.ts', () => {
  it('has every table and no other', async () => {
    const rows = await rawQuery<{ tablename: string }>(
      `select tablename from pg_tables where schemaname = 'public' order by tablename`,
    );
    expect(rows.map((r) => r.tablename)).toEqual(configs.map((c) => c.name).sort());
    expect(rows).toHaveLength(33);
  });

  it("every foreign key has schema.ts's ON DELETE rule", async () => {
    const rows = await rawQuery<{ tbl: string; col: string; ref: string; action: string }>(
      `select c.conrelid::regclass::text as tbl,
              a.attname as col,
              c.confrelid::regclass::text as ref,
              c.confdeltype as action
         from pg_constraint c
         join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
        where c.contype = 'f'`,
    );
    const actual = rows.map((r) => `${r.tbl}.${r.col} -> ${r.ref} on delete ${ACTION[r.action]}`).sort();
    const expected = configs
      .flatMap((c) =>
        c.foreignKeys.map((fk) => {
          const ref = fk.reference();
          return `${c.name}.${ref.columns[0].name} -> ${getTableConfig(ref.foreignTable).name} on delete ${fk.onDelete ?? 'no action'}`;
        }),
      )
      .sort();
    expect(actual).toEqual(expected);
    expect(actual).toContain('legs.trip_id -> trips on delete cascade');
    expect(actual).toContain('usage_events.user_id -> users on delete set null');
  });

  it('every unique index in schema.ts exists, unique, with its predicate', async () => {
    const rows = await rawQuery<{ name: string; def: string }>(
      `select i.relname as name, pg_get_indexdef(x.indexrelid) as def
         from pg_index x join pg_class i on i.oid = x.indexrelid
        where x.indisunique and not x.indisprimary`,
    );
    const byName = new Map(rows.map((r) => [r.name, r.def]));
    const declared = configs.flatMap((c) =>
      c.indexes.filter((i) => i.config.unique).map((i) => i.config.name!),
    );
    expect(declared.length).toBeGreaterThan(0);
    for (const name of declared) expect(byName.get(name), name).toMatch(/^CREATE UNIQUE INDEX/);
    expect(byName.get('penny_turns_one_running_per_trip_idx')).toMatch(/WHERE \(status = 'running'::text\)/);
    expect(byName.get('trips_user_name_unique_idx')).toMatch(/\(user_id, trip_name_ci_key\)/);
  });

  it('trip_name_ci_key is a stored generated column', async () => {
    const [row] = await rawQuery<{ is_generated: string; generation_expression: string }>(
      `select is_generated, generation_expression from information_schema.columns
        where table_name = 'trips' and column_name = 'trip_name_ci_key'`,
    );
    expect(row).toEqual({
      is_generated: 'ALWAYS',
      generation_expression: 'lower(TRIM(BOTH FROM name))',
    });
  });
});
