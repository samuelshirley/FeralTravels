-- Which tier the message gate sorted a chat message into, and which decider
-- decided. Null on every existing row and on rows the gate does not judge.
--
-- Additive; the code half reads them as nullable, so either order of deploy is
-- safe.
ALTER TABLE "chat_history" ADD COLUMN IF NOT EXISTS "gate_tier" text;
--> statement-breakpoint
ALTER TABLE "chat_history" ADD COLUMN IF NOT EXISTS "gate_by" text;
