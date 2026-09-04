-- CreateIndex
CREATE INDEX CONCURRENTLY "AdminLog_targetType_createdAt_id_idx" ON "AdminLog"("targetType", "createdAt", "id");
