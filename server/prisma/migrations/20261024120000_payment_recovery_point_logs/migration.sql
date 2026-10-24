-- Dispute recovery moves points without a ledger row; link the case to the
-- PointLog rows written when held points are consumed or restored.
ALTER TABLE "PaymentRecoveryCase"
  ADD COLUMN "consumedPointLogId" INTEGER,
  ADD COLUMN "restoredPointLogId" INTEGER;

CREATE UNIQUE INDEX "PaymentRecoveryCase_consumedPointLogId_key" ON "PaymentRecoveryCase"("consumedPointLogId");
CREATE UNIQUE INDEX "PaymentRecoveryCase_restoredPointLogId_key" ON "PaymentRecoveryCase"("restoredPointLogId");

ALTER TABLE "PaymentRecoveryCase" ADD CONSTRAINT "PaymentRecoveryCase_consumedPointLogId_fkey"
  FOREIGN KEY ("consumedPointLogId") REFERENCES "PointLog"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentRecoveryCase" ADD CONSTRAINT "PaymentRecoveryCase_restoredPointLogId_fkey"
  FOREIGN KEY ("restoredPointLogId") REFERENCES "PointLog"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
