-- CreateIndex
CREATE INDEX CONCURRENTLY "AdminLog_adminUserId_createdAt_id_idx" ON "AdminLog"("adminUserId", "createdAt", "id");
