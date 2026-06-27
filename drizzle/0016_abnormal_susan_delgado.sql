ALTER TABLE "stops" ADD COLUMN "price_state" text;--> statement-breakpoint
ALTER TABLE "stops" ADD COLUMN "price_per_litre" double precision;--> statement-breakpoint
ALTER TABLE "stops" ADD COLUMN "price_currency" text;--> statement-breakpoint
ALTER TABLE "stops" ADD COLUMN "price_fuel_type" text;--> statement-breakpoint
ALTER TABLE "stops" ADD COLUMN "price_country" text;--> statement-breakpoint
ALTER TABLE "stops" ADD COLUMN "price_source" text;--> statement-breakpoint
ALTER TABLE "stops" ADD COLUMN "price_as_of" timestamp;--> statement-breakpoint
ALTER TABLE "vehicles" ADD COLUMN "fuel_type" text;