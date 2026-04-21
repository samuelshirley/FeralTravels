-- Rip out iOverlander / Park4Night source tags.
--
-- Context: the app used to offer "Open in iOverlander" / "Open in Park4Night"
-- deep links that landed users on those services' place pages with a coord
-- prefill. We removed those integrations (the URLs were brittle and we don't
-- want to scrape against their ToS) in favor of Google Maps dog park / park
-- search chips + a Copy GPS button. The TypeScript enums for
-- `stops.source` and `routes.end_source` were narrowed accordingly, which
-- would fail-read any legacy rows still holding 'ioverlander' or 'park4night'.
--
-- The columns are plain `text` (no CHECK), so this is a data-only rewrite —
-- no schema change needed. Re-tag legacy rows as 'manual' (the closest
-- neutral provenance) so the UI renders them correctly and Zod validation
-- on PATCH doesn't 400.

UPDATE "stops"
SET "source" = 'manual'
WHERE "source" IN ('ioverlander', 'park4night');--> statement-breakpoint

UPDATE "routes"
SET "end_source" = 'manual'
WHERE "end_source" IN ('ioverlander', 'park4night');
