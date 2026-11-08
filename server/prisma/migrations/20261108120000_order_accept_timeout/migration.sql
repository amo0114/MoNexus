-- Unaccepted manual orders can be cancelled by the buyer or expire after the
-- accept deadline frozen at order time. Existing orders keep acceptBy = NULL
-- and are not touched by the timeout scan.
ALTER TABLE "Order" ADD COLUMN "acceptBy" TIMESTAMP(3);
ALTER TABLE "Order" ADD COLUMN "cancelRequestedAt" TIMESTAMP(3);
ALTER TABLE "Order" ADD COLUMN "resolutionReason" TEXT;

CREATE INDEX "Order_status_acceptBy_idx" ON "Order"("status", "acceptBy");
