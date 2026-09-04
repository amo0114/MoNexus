-- CreateIndex
CREATE INDEX CONCURRENTLY IF NOT EXISTS "PointLog_type_createdAt_id_idx" ON "PointLog"("type", "createdAt", "id");
