-- Dispute timers: the seller must propose a remedy before disputeRespondBy;
-- the buyer must accept or reject it before remedyRespondBy (lapse = accept).
-- Existing disputed orders keep NULL timers and stay with admin arbitration.
ALTER TABLE "Order" ADD COLUMN "disputeRespondBy" TIMESTAMP(3);
ALTER TABLE "Order" ADD COLUMN "remedyNote" TEXT;
ALTER TABLE "Order" ADD COLUMN "remedyProposedAt" TIMESTAMP(3);
ALTER TABLE "Order" ADD COLUMN "remedyRespondBy" TIMESTAMP(3);
ALTER TABLE "Order" ADD COLUMN "disputeEscalatedAt" TIMESTAMP(3);

CREATE INDEX "Order_status_disputeRespondBy_idx" ON "Order"("status", "disputeRespondBy");
CREATE INDEX "Order_status_remedyRespondBy_idx" ON "Order"("status", "remedyRespondBy");
