-- CreateIndex
CREATE INDEX CONCURRENTLY "InventoryItem_productId_status_idx" ON "InventoryItem"("productId", "status");
