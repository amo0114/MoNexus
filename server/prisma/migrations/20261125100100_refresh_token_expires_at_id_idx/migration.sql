-- Single statement: keep concurrent index creation outside a multi-statement transaction.
CREATE INDEX CONCURRENTLY "RefreshToken_expiresAt_id_idx" ON "RefreshToken"("expiresAt", "id");
