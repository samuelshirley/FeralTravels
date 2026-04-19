import 'server-only';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from './schema';

declare global {
  // eslint-disable-next-line no-var
  var __pgClient: ReturnType<typeof postgres> | undefined;
}

function makeClient() {
  // Allow a placeholder URL during `next build`'s "collect page data" pass, when
  // env vars aren't injected yet. The connection is lazy: postgres-js only
  // actually connects on the first query, so this is safe.
  const url =
    process.env.DATABASE_URL ||
    'postgres://placeholder:placeholder@127.0.0.1:5432/placeholder';
  return postgres(url, {
    prepare: false,
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10,
  });
}

const client = global.__pgClient ?? makeClient();
if (process.env.NODE_ENV !== 'production') global.__pgClient = client;

export const db = drizzle(client, { schema, logger: false });
export type DB = typeof db;
export { schema };
