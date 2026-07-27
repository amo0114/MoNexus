-- P7a: CronLease — cron fleet lease for multi-instance deployments.
-- Mutual exclusion while a batch runs (heartbeat renewal) + window throttling
-- (at most one fleet-wide start per TTL window). All time comparisons use the
-- database clock (now()), never instance clocks.
CREATE TABLE "CronLease" (
    "name" TEXT NOT NULL,
    "holder" TEXT NOT NULL,
    "leaseToken" TEXT NOT NULL,
    "lockedUntil" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CronLease_pkey" PRIMARY KEY ("name")
);
