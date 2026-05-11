-- Trip-level routing hint: Penny merges this with explicit get_route avoid[].
ALTER TABLE trips
  ADD COLUMN IF NOT EXISTS prefer_avoid_highways boolean NOT NULL DEFAULT false;
