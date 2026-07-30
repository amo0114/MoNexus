-- In-flight provision cancel gate: refund while HTTP is running sets this
-- instead of hard-cancelling, so success after refund can queue revoke.
ALTER TABLE "FakaBridgeTask" ADD COLUMN IF NOT EXISTS "cancelRequested" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS "FakaBridgeTask_status_cancelRequested_idx"
  ON "FakaBridgeTask"("status", "cancelRequested");
