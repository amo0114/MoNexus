-- Admin-only sandbox ledger. Existing cash balances and recharge rows remain unchanged.
ALTER TABLE "PointAccount"
  ADD COLUMN "sandboxBalance" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "RechargeQuote"
  ADD COLUMN "adminSandbox" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "RechargeOrder"
  ADD COLUMN "adminSandbox" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "RechargeCredit"
  ADD COLUMN "adminSandbox" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "PointAccount"
  ADD CONSTRAINT "PointAccount_sandbox_balance_check"
  CHECK ("sandboxBalance" >= 0 AND "sandboxBalance" <= 2000000000);
