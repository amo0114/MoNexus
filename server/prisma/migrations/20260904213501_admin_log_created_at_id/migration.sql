-- CreateIndex
CREATE INDEX CONCURRENTLY "AdminLog_createdAt_id_idx" ON "AdminLog"("createdAt", "id");
