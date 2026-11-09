-- Single statement: keep concurrent index creation outside a multi-statement transaction.
CREATE INDEX CONCURRENTLY "PaymentRecoveryCase_rechargeCreditId_idx" ON "PaymentRecoveryCase"("rechargeCreditId");
