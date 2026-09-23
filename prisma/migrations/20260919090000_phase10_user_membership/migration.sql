-- Phase 10 — user membership lifecycle fields.
--
-- Adds to "user_businesses" (Prisma model UserBusiness):
--   updatedAt   when the membership last changed (role change, disable/enable)
--   invitedBy   the user id of whoever added this person to the business
--   disabledAt  non-null = access revoked; jwt.strategy.ts rejects the
--               session on the very next request, and listMembers reports
--               the membership as inactive rather than hiding it
--
-- Written idempotently (IF NOT EXISTS) because this repo has been managed
-- with `prisma db push` rather than a migration history — see README.md in
-- this directory for how to apply it either way.

ALTER TABLE "user_businesses"
  ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "user_businesses"
  ADD COLUMN IF NOT EXISTS "invitedBy" TEXT;

ALTER TABLE "user_businesses"
  ADD COLUMN IF NOT EXISTS "disabledAt" TIMESTAMP(3);

-- Every existing membership predates this change and is active by
-- definition; the NULL default already says so, this is just explicit.
UPDATE "user_businesses" SET "disabledAt" = NULL WHERE "disabledAt" IS NOT NULL AND FALSE;

-- jwt.strategy.ts now re-reads the membership on every authenticated
-- request, so this lookup moves from once-per-login to once-per-request.
-- The @@unique([userId, businessId]) index already covers it; this is the
-- covering index for the members list and the last-owner check.
CREATE INDEX IF NOT EXISTS "user_businesses_businessId_role_idx"
  ON "user_businesses" ("businessId", "role");
