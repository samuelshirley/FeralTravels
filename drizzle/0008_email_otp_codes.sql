-- OTP code table for email-based sign-in.
-- Replaces magic-link flow: user enters email, gets a 6-digit code by email,
-- enters it on /login/verify, and gets a session. Codes expire in 10 minutes
-- and are deleted on first use (or after 5 failed attempts).

CREATE TABLE "email_otp_codes" (
  "id" serial PRIMARY KEY NOT NULL,
  "email" text NOT NULL,
  "code" text NOT NULL,
  "expires" timestamp NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "otp_email_idx" ON "email_otp_codes" ("email");
