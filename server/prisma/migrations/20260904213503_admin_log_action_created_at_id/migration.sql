-- CreateIndex
CREATE INDEX CONCURRENTLY "AdminLog_action_createdAt_id_idx" ON "AdminLog"("action", "createdAt", "id");
