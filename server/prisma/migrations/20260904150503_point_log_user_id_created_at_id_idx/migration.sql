-- CreateIndex
CREATE INDEX CONCURRENTLY IF NOT EXISTS "PointLog_userId_createdAt_id_idx" ON "PointLog"("userId", "createdAt", "id");
