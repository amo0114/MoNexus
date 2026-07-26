-- P4a migration 1/3: create the Offer (SKU) table and add nullable offerId
-- columns to the related tables. Purely additive — no existing column or
-- constraint is touched, so this step is safely reversible (drop table /
-- drop columns). Backfill happens in 20260725201000; the NOT NULL tightening
-- for InventoryItem.offerId happens in 20260725202000 only after the backfill
-- has been verified.

-- CreateTable
CREATE TABLE "Offer" (
    "id" SERIAL NOT NULL,
    "productId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "price" INTEGER NOT NULL,
    "originalPrice" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'active',
    "deliveryMode" TEXT NOT NULL DEFAULT 'instant_inventory',
    "stockMode" TEXT NOT NULL DEFAULT 'limited',
    "stock" INTEGER NOT NULL DEFAULT 0,
    "fixedContent" TEXT,
    "fixedContentType" TEXT NOT NULL DEFAULT 'text',
    "sales" INTEGER NOT NULL DEFAULT 0,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Offer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Offer_productId_status_sortOrder_idx" ON "Offer"("productId", "status", "sortOrder");

-- AddForeignKey
ALTER TABLE "Offer" ADD CONSTRAINT "Offer_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Offer commercial CHECK constraints mirror the Product rules from
-- 20260724120000: PostgreSQL stays the final authority even when rows are
-- changed outside the API.
ALTER TABLE "Offer"
  ADD CONSTRAINT "Offer_price_positive_check" CHECK ("price" > 0),
  ADD CONSTRAINT "Offer_originalPrice_not_less_than_price_check"
    CHECK ("originalPrice" IS NULL OR "originalPrice" >= "price"),
  ADD CONSTRAINT "Offer_stock_non_negative_check" CHECK ("stock" >= 0),
  ADD CONSTRAINT "Offer_sales_non_negative_check" CHECK ("sales" >= 0),
  ADD CONSTRAINT "Offer_status_allowed_check" CHECK ("status" IN ('active', 'inactive')),
  ADD CONSTRAINT "Offer_deliveryMode_allowed_check"
    CHECK ("deliveryMode" IN ('instant_inventory', 'instant_fixed', 'manual_service')),
  ADD CONSTRAINT "Offer_stockMode_allowed_check" CHECK ("stockMode" IN ('limited', 'unlimited')),
  ADD CONSTRAINT "Offer_fixedContentType_allowed_check" CHECK ("fixedContentType" IN ('text', 'url')),
  ADD CONSTRAINT "Offer_instant_inventory_limited_check"
    CHECK ("deliveryMode" <> 'instant_inventory' OR "stockMode" = 'limited');

-- AlterTable: nullable offerId columns (tightened / kept nullable per plan)
ALTER TABLE "InventoryItem" ADD COLUMN "offerId" INTEGER;
ALTER TABLE "Order" ADD COLUMN "offerId" INTEGER,
                    ADD COLUMN "offerNameSnapshot" TEXT;
ALTER TABLE "InventoryLog" ADD COLUMN "offerId" INTEGER;

-- CreateIndex
CREATE INDEX "InventoryItem_offerId_status_idx" ON "InventoryItem"("offerId", "status");

-- AddForeignKey (InventoryLog.offerId deliberately has no FK: audit rows must
-- not be entangled with the Offer lifecycle)
ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "Offer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Order" ADD CONSTRAINT "Order_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "Offer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
