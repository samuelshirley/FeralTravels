-- The Jev classifier switch, and somewhere to write what Jev said.
--
-- `users.jev_mode`: NULL follows the global `app_meta.jev_mode` row; 'on'
-- forces Jev-first for this account, 'off' forces Haiku only. NULL on every
-- existing row, so nothing changes until an admin flips something.
--
-- `usage_events.meta`: structured facts about a call, written today only by
-- `provider = 'jev'` rows ({mode, choice, top, margin, latencyMs, settled,
-- deferredReason, echoedModel}) and never user text.
--
-- The global switch is an `app_meta` row and needs no DDL: a missing row reads
-- as OFF. Additive; either order of deploy is safe.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "jev_mode" text;--> statement-breakpoint
ALTER TABLE "usage_events" ADD COLUMN IF NOT EXISTS "meta" jsonb;
