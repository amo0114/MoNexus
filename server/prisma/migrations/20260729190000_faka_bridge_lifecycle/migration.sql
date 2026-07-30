-- FakaBridge lifecycle: revoke on refund + reconcile notes
ALTER TABLE "FakaBridgeTask" ADD COLUMN IF NOT EXISTS "revokeStatus" TEXT;
ALTER TABLE "FakaBridgeTask" ADD COLUMN IF NOT EXISTS "revokeAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "FakaBridgeTask" ADD COLUMN IF NOT EXISTS "revokedAt" TIMESTAMP(3);
ALTER TABLE "FakaBridgeTask" ADD COLUMN IF NOT EXISTS "lastRevokeError" TEXT;
ALTER TABLE "FakaBridgeTask" ADD COLUMN IF NOT EXISTS "reconcileNote" TEXT;

CREATE INDEX IF NOT EXISTS "FakaBridgeTask_revokeStatus_idx" ON "FakaBridgeTask"("revokeStatus");
CREATE INDEX IF NOT EXISTS "FakaBridgeTask_status_completedAt_idx" ON "FakaBridgeTask"("status", "completedAt");
