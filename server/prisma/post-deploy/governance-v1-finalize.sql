-- Run through governance-migrate finalize only, after preflight/backfill.
-- NOT VALID separates installation from validation; this file is idempotent.
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='User_governance_status_check') THEN
  ALTER TABLE "User" ADD CONSTRAINT "User_governance_status_check" CHECK (status IN ('active','banned')) NOT VALID;
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='User_governance_role_check') THEN
  ALTER TABLE "User" ADD CONSTRAINT "User_governance_role_check" CHECK (role IN ('user','merchant','admin')) NOT VALID;
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='Merchant_governance_status_check') THEN
  ALTER TABLE "Merchant" ADD CONSTRAINT "Merchant_governance_status_check" CHECK (status IN ('pending','active','rejected','suspended')) NOT VALID;
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='Order_governance_status_check') THEN
  ALTER TABLE "Order" ADD CONSTRAINT "Order_governance_status_check" CHECK (status IN ('pending','processing','delivered','disputed','closed','refunded')) NOT VALID;
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='Order_governance_number_check') THEN
  ALTER TABLE "Order" ADD CONSTRAINT "Order_governance_number_check" CHECK ("orderNo" IS NOT NULL) NOT VALID;
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='SettlementBatch_governance_number_check') THEN
  ALTER TABLE "SettlementBatch" ADD CONSTRAINT "SettlementBatch_governance_number_check" CHECK ("batchNo" IS NOT NULL) NOT VALID;
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='OrderAfterSalesCase_governance_number_check') THEN
  ALTER TABLE "OrderAfterSalesCase" ADD CONSTRAINT "OrderAfterSalesCase_governance_number_check" CHECK ("caseNo" IS NOT NULL) NOT VALID;
 END IF;
END $$;
ALTER TABLE "User" VALIDATE CONSTRAINT "User_governance_status_check";
ALTER TABLE "User" VALIDATE CONSTRAINT "User_governance_role_check";
ALTER TABLE "Merchant" VALIDATE CONSTRAINT "Merchant_governance_status_check";
ALTER TABLE "Order" VALIDATE CONSTRAINT "Order_governance_status_check";
ALTER TABLE "Order" VALIDATE CONSTRAINT "Order_governance_number_check";
ALTER TABLE "SettlementBatch" VALIDATE CONSTRAINT "SettlementBatch_governance_number_check";
ALTER TABLE "OrderAfterSalesCase" VALIDATE CONSTRAINT "OrderAfterSalesCase_governance_number_check";
