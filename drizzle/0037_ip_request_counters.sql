-- Per-IP request counters: one row per (scope, address, window).
--
-- A counter rather than a request log, so the table grows with the number of
-- distinct addresses rather than with the size of the flood it exists to
-- survive. `window_start` is epoch millis floored to the scope's window, so
-- every instance buckets a request identically without coordinating and the
-- write is a single upsert.
CREATE TABLE IF NOT EXISTS "ip_request_counters" (
  "scope" text NOT NULL,
  "ip" text NOT NULL,
  "window_start" bigint NOT NULL,
  "count" integer DEFAULT 0 NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "ip_request_counters_scope_ip_window_start_pk" PRIMARY KEY("scope","ip","window_start")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ip_request_counters_updated_idx" ON "ip_request_counters" ("updated_at");
