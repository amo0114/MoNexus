-- SPEC: docs/implementation/2026-11-10-commerce-accounting-settlement-closure-plan.md
-- wallet 来源批次 / 商家结算批次与冲正 / 订单售后。纯增量；旧列保留。

-- AlterTable
ALTER TABLE "PointAccount" ADD COLUMN     "walletInitializedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "PointLog" ADD COLUMN     "growthEligible" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "ReconciliationRun" ADD COLUMN     "coverage" JSONB;

-- CreateTable
CREATE TABLE "WalletOperation" (
    "id" SERIAL NOT NULL,
    "operationKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "amount" INTEGER NOT NULL,
    "requestHash" CHAR(64) NOT NULL,
    "sourceKind" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "reasonCode" TEXT NOT NULL,
    "actorUserId" INTEGER,
    "parentOperationId" INTEGER,
    "balanceAfter" INTEGER NOT NULL,
    "frozenAfter" INTEGER NOT NULL,
    "pointLogId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WalletOperation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PointLot" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "originKind" TEXT NOT NULL,
    "sourceOperationId" INTEGER NOT NULL,
    "issuedPoints" INTEGER NOT NULL,
    "availablePoints" INTEGER NOT NULL,
    "frozenPoints" INTEGER NOT NULL DEFAULT 0,
    "consumedPoints" INTEGER NOT NULL DEFAULT 0,
    "policyVersion" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PointLot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WalletAllocation" (
    "id" SERIAL NOT NULL,
    "operationId" INTEGER NOT NULL,
    "lotId" INTEGER NOT NULL,
    "availableDelta" INTEGER NOT NULL,
    "frozenDelta" INTEGER NOT NULL,
    "consumedDelta" INTEGER NOT NULL,
    "parentAllocationId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WalletAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SettlementBatch" (
    "id" SERIAL NOT NULL,
    "requestKey" TEXT NOT NULL,
    "requestHash" CHAR(64) NOT NULL,
    "createdByUserId" INTEGER NOT NULL,
    "itemCount" INTEGER NOT NULL,
    "totalPoints" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SettlementBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SettlementBatchItem" (
    "id" SERIAL NOT NULL,
    "batchId" INTEGER NOT NULL,
    "settlementId" INTEGER NOT NULL,
    "merchantId" INTEGER NOT NULL,
    "merchantUserId" INTEGER NOT NULL,
    "amount" INTEGER NOT NULL,
    "destination" TEXT NOT NULL DEFAULT 'wallet_points',
    "walletOperationId" INTEGER,

    CONSTRAINT "SettlementBatchItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SettlementAdjustment" (
    "id" SERIAL NOT NULL,
    "settlementId" INTEGER NOT NULL,
    "afterSalesCaseId" INTEGER NOT NULL,
    "merchantId" INTEGER NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'after_sales_reversal',
    "orderAmountDelta" INTEGER NOT NULL,
    "commissionDelta" INTEGER NOT NULL,
    "settlementDelta" INTEGER NOT NULL,
    "clawbackPoints" INTEGER NOT NULL DEFAULT 0,
    "clawbackOperationId" INTEGER,
    "reason" TEXT NOT NULL,
    "createdByUserId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SettlementAdjustment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MerchantRecoveryCase" (
    "id" SERIAL NOT NULL,
    "adjustmentId" INTEGER NOT NULL,
    "merchantId" INTEGER NOT NULL,
    "amountDue" INTEGER NOT NULL,
    "amountCollected" INTEGER NOT NULL DEFAULT 0,
    "amountWaived" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'open',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "MerchantRecoveryCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MerchantRecoveryAction" (
    "id" SERIAL NOT NULL,
    "caseId" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "requestKey" TEXT NOT NULL,
    "walletOperationId" INTEGER,
    "evidence" TEXT,
    "note" TEXT,
    "actorUserId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MerchantRecoveryAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderAfterSalesCase" (
    "id" SERIAL NOT NULL,
    "orderId" INTEGER NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'full_refund',
    "status" TEXT NOT NULL DEFAULT 'open',
    "reason" TEXT NOT NULL,
    "evidence" TEXT,
    "createdByUserId" INTEGER NOT NULL,
    "decidedByUserId" INTEGER,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "refundOperationId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderAfterSalesCase_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WalletOperation_operationKey_key" ON "WalletOperation"("operationKey");

-- CreateIndex
CREATE UNIQUE INDEX "WalletOperation_pointLogId_key" ON "WalletOperation"("pointLogId");

-- CreateIndex
CREATE INDEX "WalletOperation_userId_createdAt_idx" ON "WalletOperation"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "WalletOperation_sourceKind_sourceId_idx" ON "WalletOperation"("sourceKind", "sourceId");

-- CreateIndex
CREATE INDEX "WalletOperation_parentOperationId_idx" ON "WalletOperation"("parentOperationId");

-- CreateIndex
CREATE INDEX "PointLot_userId_id_idx" ON "PointLot"("userId", "id");

-- CreateIndex
CREATE INDEX "PointLot_sourceOperationId_idx" ON "PointLot"("sourceOperationId");

-- CreateIndex
CREATE INDEX "WalletAllocation_operationId_idx" ON "WalletAllocation"("operationId");

-- CreateIndex
CREATE INDEX "WalletAllocation_lotId_idx" ON "WalletAllocation"("lotId");

-- CreateIndex
CREATE INDEX "WalletAllocation_parentAllocationId_idx" ON "WalletAllocation"("parentAllocationId");

-- CreateIndex
CREATE UNIQUE INDEX "SettlementBatch_requestKey_key" ON "SettlementBatch"("requestKey");

-- CreateIndex
CREATE INDEX "SettlementBatch_createdAt_id_idx" ON "SettlementBatch"("createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "SettlementBatchItem_settlementId_key" ON "SettlementBatchItem"("settlementId");

-- CreateIndex
CREATE UNIQUE INDEX "SettlementBatchItem_walletOperationId_key" ON "SettlementBatchItem"("walletOperationId");

-- CreateIndex
CREATE INDEX "SettlementBatchItem_batchId_idx" ON "SettlementBatchItem"("batchId");

-- CreateIndex
CREATE INDEX "SettlementBatchItem_merchantId_idx" ON "SettlementBatchItem"("merchantId");

-- CreateIndex
CREATE UNIQUE INDEX "SettlementAdjustment_afterSalesCaseId_key" ON "SettlementAdjustment"("afterSalesCaseId");

-- CreateIndex
CREATE UNIQUE INDEX "SettlementAdjustment_clawbackOperationId_key" ON "SettlementAdjustment"("clawbackOperationId");

-- CreateIndex
CREATE INDEX "SettlementAdjustment_settlementId_idx" ON "SettlementAdjustment"("settlementId");

-- CreateIndex
CREATE INDEX "SettlementAdjustment_merchantId_createdAt_idx" ON "SettlementAdjustment"("merchantId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "MerchantRecoveryCase_adjustmentId_key" ON "MerchantRecoveryCase"("adjustmentId");

-- CreateIndex
CREATE INDEX "MerchantRecoveryCase_merchantId_status_idx" ON "MerchantRecoveryCase"("merchantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "MerchantRecoveryAction_requestKey_key" ON "MerchantRecoveryAction"("requestKey");

-- CreateIndex
CREATE UNIQUE INDEX "MerchantRecoveryAction_walletOperationId_key" ON "MerchantRecoveryAction"("walletOperationId");

-- CreateIndex
CREATE INDEX "MerchantRecoveryAction_caseId_createdAt_idx" ON "MerchantRecoveryAction"("caseId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "OrderAfterSalesCase_refundOperationId_key" ON "OrderAfterSalesCase"("refundOperationId");

-- CreateIndex
CREATE INDEX "OrderAfterSalesCase_orderId_idx" ON "OrderAfterSalesCase"("orderId");

-- CreateIndex
CREATE INDEX "OrderAfterSalesCase_status_createdAt_idx" ON "OrderAfterSalesCase"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "WalletOperation" ADD CONSTRAINT "WalletOperation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletOperation" ADD CONSTRAINT "WalletOperation_parentOperationId_fkey" FOREIGN KEY ("parentOperationId") REFERENCES "WalletOperation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletOperation" ADD CONSTRAINT "WalletOperation_pointLogId_fkey" FOREIGN KEY ("pointLogId") REFERENCES "PointLog"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PointLot" ADD CONSTRAINT "PointLot_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PointLot" ADD CONSTRAINT "PointLot_sourceOperationId_fkey" FOREIGN KEY ("sourceOperationId") REFERENCES "WalletOperation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletAllocation" ADD CONSTRAINT "WalletAllocation_operationId_fkey" FOREIGN KEY ("operationId") REFERENCES "WalletOperation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletAllocation" ADD CONSTRAINT "WalletAllocation_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "PointLot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletAllocation" ADD CONSTRAINT "WalletAllocation_parentAllocationId_fkey" FOREIGN KEY ("parentAllocationId") REFERENCES "WalletAllocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SettlementBatchItem" ADD CONSTRAINT "SettlementBatchItem_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "SettlementBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SettlementBatchItem" ADD CONSTRAINT "SettlementBatchItem_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "Settlement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SettlementBatchItem" ADD CONSTRAINT "SettlementBatchItem_walletOperationId_fkey" FOREIGN KEY ("walletOperationId") REFERENCES "WalletOperation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SettlementAdjustment" ADD CONSTRAINT "SettlementAdjustment_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "Settlement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SettlementAdjustment" ADD CONSTRAINT "SettlementAdjustment_afterSalesCaseId_fkey" FOREIGN KEY ("afterSalesCaseId") REFERENCES "OrderAfterSalesCase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SettlementAdjustment" ADD CONSTRAINT "SettlementAdjustment_clawbackOperationId_fkey" FOREIGN KEY ("clawbackOperationId") REFERENCES "WalletOperation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MerchantRecoveryCase" ADD CONSTRAINT "MerchantRecoveryCase_adjustmentId_fkey" FOREIGN KEY ("adjustmentId") REFERENCES "SettlementAdjustment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MerchantRecoveryAction" ADD CONSTRAINT "MerchantRecoveryAction_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "MerchantRecoveryCase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MerchantRecoveryAction" ADD CONSTRAINT "MerchantRecoveryAction_walletOperationId_fkey" FOREIGN KEY ("walletOperationId") REFERENCES "WalletOperation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderAfterSalesCase" ADD CONSTRAINT "OrderAfterSalesCase_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderAfterSalesCase" ADD CONSTRAINT "OrderAfterSalesCase_refundOperationId_fkey" FOREIGN KEY ("refundOperationId") REFERENCES "WalletOperation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ── 来源守恒与非负约束（Prisma 无法表达）──
ALTER TABLE "PointLot" ADD CONSTRAINT "PointLot_conservation_check"
    CHECK ("issuedPoints" > 0 AND "availablePoints" >= 0 AND "frozenPoints" >= 0 AND "consumedPoints" >= 0
      AND "issuedPoints"::bigint = "availablePoints"::bigint + "frozenPoints"::bigint + "consumedPoints"::bigint);
ALTER TABLE "PointLot" ADD CONSTRAINT "PointLot_origin_check"
    CHECK ("originKind" IN ('recharge', 'reward', 'merchant_settlement', 'admin_adjustment', 'legacy_unknown'));
ALTER TABLE "WalletOperation" ADD CONSTRAINT "WalletOperation_amount_check" CHECK ("amount" >= 0);
ALTER TABLE "SettlementBatch" ADD CONSTRAINT "SettlementBatch_totals_check" CHECK ("itemCount" > 0 AND "totalPoints" >= 0);
ALTER TABLE "SettlementBatchItem" ADD CONSTRAINT "SettlementBatchItem_amount_check"
    CHECK ("amount" >= 0 AND ("walletOperationId" IS NOT NULL) = ("amount" > 0));
ALTER TABLE "SettlementAdjustment" ADD CONSTRAINT "SettlementAdjustment_amount_check"
    CHECK ("orderAmountDelta" <= 0 AND "commissionDelta" <= 0 AND "settlementDelta" <= 0
      AND "clawbackPoints" >= 0 AND "clawbackPoints" <= -"settlementDelta"
      AND ("clawbackOperationId" IS NOT NULL) = ("clawbackPoints" > 0));
ALTER TABLE "MerchantRecoveryCase" ADD CONSTRAINT "MerchantRecoveryCase_amount_check"
    CHECK ("amountDue" > 0 AND "amountCollected" >= 0 AND "amountWaived" >= 0
      AND "amountCollected" + "amountWaived" <= "amountDue"
      AND ("status" = 'closed') = ("amountCollected" + "amountWaived" = "amountDue"));
ALTER TABLE "MerchantRecoveryAction" ADD CONSTRAINT "MerchantRecoveryAction_amount_check"
    CHECK ("amount" > 0 AND ("walletOperationId" IS NOT NULL) = ("kind" = 'wallet_clawback')
      AND "kind" IN ('wallet_clawback', 'offline_received', 'waived'));
ALTER TABLE "OrderAfterSalesCase" ADD CONSTRAINT "OrderAfterSalesCase_status_check"
    CHECK ("status" IN ('open', 'executed', 'rejected') AND ("refundOperationId" IS NULL OR "status" = 'executed'));

-- 同一订单至多一个有效全额退款案件；驳回历史保留。
CREATE UNIQUE INDEX "OrderAfterSalesCase_one_active_per_order"
    ON "OrderAfterSalesCase"("orderId") WHERE "status" IN ('open', 'executed');
-- 分配扫描只看仍有可用积分的来源（按入账顺序）。
CREATE INDEX "PointLot_user_available_idx" ON "PointLot"("userId", "id") WHERE "availablePoints" > 0;

-- ── 成长资格回填：既有 'in' 流水沿用原口径，仅可证明的充值入账排除 ──
UPDATE "PointLog" SET "growthEligible" = true
WHERE "type" = 'in' AND "id" NOT IN (SELECT "pointLogId" FROM "RechargeCredit");

-- ── 历史余额初始化：现存可用/冻结余额整体记为 legacy_unknown，不伪装成充值或奖励 ──
INSERT INTO "WalletOperation" ("operationKey", "kind", "userId", "amount", "requestHash", "sourceKind", "sourceId",
    "reasonCode", "balanceAfter", "frozenAfter")
SELECT 'wallet-init:' || a."userId", 'legacy_init', a."userId", a."balance" + a."frozenBalance",
    encode(sha256(convert_to('wallet-init:' || a."userId" || ':' || a."balance" || ':' || a."frozenBalance", 'UTF8')), 'hex'),
    'migration', 'wallet-v1', 'legacy_init', a."balance", a."frozenBalance"
FROM "PointAccount" a
WHERE a."balance" + a."frozenBalance" > 0;

INSERT INTO "PointLot" ("userId", "originKind", "sourceOperationId", "issuedPoints", "availablePoints", "frozenPoints")
SELECT o."userId", 'legacy_unknown', o."id", o."amount", o."balanceAfter", o."frozenAfter"
FROM "WalletOperation" o WHERE o."kind" = 'legacy_init';

INSERT INTO "WalletAllocation" ("operationId", "lotId", "availableDelta", "frozenDelta", "consumedDelta")
SELECT l."sourceOperationId", l."id", l."availablePoints", l."frozenPoints", 0
FROM "PointLot" l;

UPDATE "PointAccount" SET "walletInitializedAt" = CURRENT_TIMESTAMP;
