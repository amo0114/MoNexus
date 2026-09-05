-- CreateIndex
CREATE INDEX CONCURRENTLY "Product_createdAt_id_idx" ON "Product"("createdAt", "id");
