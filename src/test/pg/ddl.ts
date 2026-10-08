import { createRequire } from 'node:module';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as schema from '@/server/db/schema';

/**
 * The DDL for `src/server/db/schema.ts`, produced by drizzle-kit's own
 * `pushSchema` against an empty PGlite. Built from the schema rather than the
 * migration chain because that chain cannot be replayed from an empty database
 * (CLAUDE.md, "Working with this codebase").
 *
 * `require`, not `import`: `drizzle-kit/api.mjs` is a bundle that calls
 * `require('fs')` and dies under Vite's ESM loader; the CJS build does not.
 */
export async function schemaDdl(): Promise<string[]> {
  const { pushSchema } = createRequire(import.meta.url)(
    'drizzle-kit/api',
  ) as typeof import('drizzle-kit/api');
  const client = new PGlite();
  try {
    const db = drizzle(client, { schema });
    const result = await pushSchema(schema as Record<string, unknown>, db as never);
    return result.statementsToExecute;
  } finally {
    await client.close();
  }
}
