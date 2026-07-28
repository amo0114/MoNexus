-- P7a: CronLease — cron fleet lease for multi-instance deployments.
-- Two orthogonal mechanisms (PR #52 review P1: scheduling period and lease
-- lifetime are decoupled):
--   * run mutex   ("lockedUntil"): fixed short TTL + heartbeat, released at
--     batch end; expires naturally (<= 90s) after a crash.
--   * throttling  ("lastStartedAt"): acquisitions within "period - margin"
--     of the previous start are rejected; the window is strictly shorter
--     than the scheduling period so short batches run every period.
-- All time comparisons use the database clock (now()), never instance clocks.
CREATE TABLE "CronLease" (
    "name" TEXT NOT NULL,
    "holder" TEXT NOT NULL,
    "leaseToken" TEXT NOT NULL,
    "lockedUntil" TIMESTAMP(3) NOT NULL,
    "lastStartedAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CronLease_pkey" PRIMARY KEY ("name")
);
