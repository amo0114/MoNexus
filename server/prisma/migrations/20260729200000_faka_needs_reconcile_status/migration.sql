-- Allow parking uncertain provision outcomes for reconcile (no refund yet).
ALTER TABLE "FakaBridgeTask" DROP CONSTRAINT IF EXISTS "FakaBridgeTask_status_check";
ALTER TABLE "FakaBridgeTask" ADD CONSTRAINT "FakaBridgeTask_status_check" CHECK (
  "status" IN ('pending', 'succeeded', 'failed', 'cancelled', 'needs_reconcile')
);
