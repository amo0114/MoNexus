CREATE INDEX CONCURRENTLY IF NOT EXISTS "User_createdAt_id_idx" ON "User"("createdAt", "id");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "User_lastLoginAt_id_idx" ON "User"("lastLoginAt", "id");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "InventoryItem_batchId_status_id_idx" ON "InventoryItem"("batchId", "status", "id");
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "Order_orderNo_key" ON "Order"("orderNo");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Order_userId_createdAt_id_idx" ON "Order"("userId", "createdAt", "id");
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "SettlementBatch_batchNo_key" ON "SettlementBatch"("batchNo");
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "OrderAfterSalesCase_caseNo_key" ON "OrderAfterSalesCase"("caseNo");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "WalletOperation_order_source_idx" ON "WalletOperation" ("sourceKind", "sourceId", "userId", kind);
