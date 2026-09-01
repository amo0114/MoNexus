-- Durable quoted order amount on reconciliation items.
-- resolutionReason stays a post-resolution note and is not used for live mismatch facts.

ALTER TABLE "ReconciliationItem"
  ADD COLUMN "quotedAmountMinor" BIGINT;
