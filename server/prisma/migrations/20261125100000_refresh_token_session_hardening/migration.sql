-- Metadata-only DDL: adding nullable columns without defaults in PostgreSQL 16
-- acquires AccessExclusiveLock briefly without scanning or rewriting rows.
-- Active-row absoluteExpiresAt backfill runs online in per-user locked primary-key
-- batches via authSessionRetention (sessionRetentionCron.ts), while runtime
-- auth/refresh paths immediately enforce the 7-day admin cap even on legacy NULL rows.
ALTER TABLE "RefreshToken"
  ADD COLUMN "absoluteExpiresAt" TIMESTAMP(3),
  ADD COLUMN "deviceLabel" TEXT,
  ADD COLUMN "ipHint" TEXT;

-- Single-row persistent cursor table for bounded cross-run expired-family cleanup.
CREATE TABLE "AuthSessionRetentionCursor" (
  "key" TEXT NOT NULL,
  "cursorExpiresAt" TIMESTAMP(3),
  "cursorId" INTEGER,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "AuthSessionRetentionCursor_pkey" PRIMARY KEY ("key")
);
