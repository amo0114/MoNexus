-- CreateIndex
CREATE INDEX CONCURRENTLY IF NOT EXISTS "PointLog_createdAt_id_idx" ON "PointLog"("createdAt", "id");
