-- The acceptance window is frozen when an order is delivered, so changing
-- autoCloseDays later only affects later deliveries. Existing delivered
-- orders keep NULL and fall back to delivery time + current setting.
ALTER TABLE "Order" ADD COLUMN "acceptanceBy" TIMESTAMP(3);

CREATE INDEX "Order_status_acceptanceBy_idx" ON "Order"("status", "acceptanceBy");
