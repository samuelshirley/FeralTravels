-- The last JWKS each OAuth provider served, one row per provider: the fallback
-- the native OAuth exchange verifies against when a live key fetch fails.
-- Apple's /auth/keys was 404ing ~1 request in 5 on 2026-09-21 and an in-memory
-- cache is empty on every cold start. See src/server/auth/jwksSource.ts.
CREATE TABLE IF NOT EXISTS "oauth_provider_keys" (
  "provider" text PRIMARY KEY NOT NULL,
  "jwks" jsonb NOT NULL,
  "fetched_at" timestamp with time zone NOT NULL
);
