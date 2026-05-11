-- Vehicle profile remediation: user nag flag + persisted caravan/water preference
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "needs_vehicle_profile_remediation" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "vehicles" ADD COLUMN IF NOT EXISTS "water_tracking_enabled" boolean;--> statement-breakpoint
UPDATE "vehicles" SET water_tracking_enabled = true
WHERE ("water_refill_days" IS NOT NULL OR "blackwater_refill_days" IS NOT NULL)
  AND "water_tracking_enabled" IS NULL;--> statement-breakpoint
UPDATE "users" u SET needs_vehicle_profile_remediation = true
WHERE EXISTS (
  SELECT 1 FROM vehicles v WHERE v.user_id = u.id AND (
    v.refill_distance_km IS NULL OR v.refill_distance_km < 1 OR v.refill_distance_km > 5000
    OR v.max_drive_hours_per_day IS NULL OR v.max_drive_hours_per_day <= 0 OR v.max_drive_hours_per_day > 24
    OR v.max_drive_hours_per_week IS NULL OR v.max_drive_hours_per_week <= 0 OR v.max_drive_hours_per_week > 168
    OR v.max_consecutive_drive_days IS NULL OR v.max_consecutive_drive_days < 1 OR v.max_consecutive_drive_days > 14
    OR v.water_tracking_enabled IS NULL
    OR (
      v.water_tracking_enabled = true
      AND (
        v.water_refill_days IS NULL OR v.water_refill_days < 1 OR v.water_refill_days > 60
        OR v.blackwater_refill_days IS NULL OR v.blackwater_refill_days < 1 OR v.blackwater_refill_days > 60
      )
    )
  )
);--> statement-breakpoint
