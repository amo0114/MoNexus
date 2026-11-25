-- Metadata-only DDL: adding nullable columns without defaults in PostgreSQL 16
-- acquires AccessExclusiveLock briefly without scanning or rewriting rows.
-- Active-row absoluteExpiresAt backfill runs online in primary-key batches via
-- authSessionRetention (sessionRetentionCron.ts), while runtime auth/refresh
-- paths immediately enforce the 7-day admin cap even on legacy NULL rows.
ALTER TABLE "RefreshToken"
  ADD COLUMN "absoluteExpiresAt" TIMESTAMP(3),
  ADD COLUMN "deviceLabel" TEXT,
  ADD COLUMN "ipHint" TEXT;
