-- Penny's dead-end reply ("Sorry, I couldn't apply that cleanly — …") marked as
-- a fact on its chat row, so both clients render "Try again" from structure
-- rather than by matching her sentence, and the button survives a reload.
-- `{ "images": n }` — how many photos the message it answered carried. NULL on
-- every existing row and every other reply. Additive; either order of deploy is
-- safe — old code never reads it, new code reads NULL as "not a fallback".
ALTER TABLE "chat_history" ADD COLUMN IF NOT EXISTS "fallback_meta" jsonb;
