import 'dotenv/config';
import type { Config } from 'drizzle-kit';

// `drizzle-kit generate` only reads the schema, so DATABASE_URL is optional there.
// `drizzle-kit push|studio|migrate` actually need it; we'll fail clearly at that point.
const databaseUrl = process.env.DATABASE_URL || 'postgres://placeholder@localhost:5432/placeholder';

export default {
  schema: './src/server/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: databaseUrl,
  },
  strict: true,
  verbose: true,
} satisfies Config;
