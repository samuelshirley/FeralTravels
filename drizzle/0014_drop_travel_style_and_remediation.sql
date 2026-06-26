ALTER TABLE "users" DROP COLUMN IF EXISTS "needs_vehicle_profile_remediation";--> statement-breakpoint
ALTER TABLE "vehicles" DROP COLUMN IF EXISTS "travel_style";--> statement-breakpoint
ALTER TABLE "vehicles" DROP COLUMN IF EXISTS "cruise_max_drive_hours";--> statement-breakpoint
ALTER TABLE "vehicles" DROP COLUMN IF EXISTS "transit_max_drive_hours";--> statement-breakpoint
ALTER TABLE "vehicles" DROP COLUMN IF EXISTS "max_drive_hours_per_day";--> statement-breakpoint
ALTER TABLE "vehicles" DROP COLUMN IF EXISTS "max_drive_hours_per_week";--> statement-breakpoint
DROP TYPE "public"."travel_style";