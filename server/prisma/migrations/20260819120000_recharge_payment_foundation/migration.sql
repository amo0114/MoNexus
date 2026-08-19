-- SPEC-RECHARGE-PAYMENT-V1.2 foundation.
-- Additive only: no seed of an active live provider and no real recharge orders.
-- PointAccount CHECK is fail-closed: existing violating rows abort the migration.

-- CreateTable
CREATE TABLE "RechargePricePolicy" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "currencyScale" INTEGER NOT NULL,
    "pointsNumerator" BIGINT NOT NULL,
    "pointsDenominator" BIGINT NOT NULL,
    "roundingMode" "MoneyRoundingMode" NOT NULL DEFAULT 'HALF_EVEN',
    "minAmountMinor" BIGINT NOT NULL,
    "maxAmountMinor" BIGINT NOT NULL,
    "amountStepMinor" BIGINT NOT NULL,
    "dailyLimitMinor" BIGINT NOT NULL,
    "monthlyLimitMinor" BIGINT NOT NULL,
    "limitTimeZone" TEXT NOT NULL,
    "bonusRuleVersion" TEXT,
    "status" TEXT NOT NULL,
    "effectiveAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RechargePricePolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RechargeSuggestedAmount" (
    "id" UUID NOT NULL,
    "policyId" UUID NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "sortOrder" INTEGER NOT NULL,

    CONSTRAINT "RechargeSuggestedAmount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RechargeQuote" (
    "id" UUID NOT NULL,
    "userId" INTEGER NOT NULL,
    "pricePolicyId" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "paymentMethod" TEXT NOT NULL,
    "providerAccountKey" TEXT NOT NULL,
    "capabilityVersion" TEXT NOT NULL,
    "capabilityDigest" TEXT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "effectiveMinAmountMinor" BIGINT NOT NULL,
    "effectiveMaxAmountMinor" BIGINT NOT NULL,
    "basePoints" BIGINT NOT NULL,
    "bonusPoints" BIGINT NOT NULL,
    "totalPoints" BIGINT NOT NULL,
    "amountSource" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RechargeQuote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RechargeOrder" (
    "id" UUID NOT NULL,
    "userId" INTEGER NOT NULL,
    "quoteId" UUID NOT NULL,
    "pricePolicyId" UUID NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "basePoints" BIGINT NOT NULL,
    "bonusPoints" BIGINT NOT NULL,
    "totalPoints" BIGINT NOT NULL,
    "pricePolicyCode" TEXT NOT NULL,
    "pricePolicyVersion" INTEGER NOT NULL,
    "pointsNumerator" BIGINT NOT NULL,
    "pointsDenominator" BIGINT NOT NULL,
    "roundingMode" "MoneyRoundingMode" NOT NULL,
    "currencyScale" INTEGER NOT NULL,
    "bonusRuleVersion" TEXT,
    "amountSource" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "paymentMethod" TEXT NOT NULL,
    "providerAccountKey" TEXT NOT NULL,
    "capabilityVersion" TEXT NOT NULL,
    "capabilityDigest" TEXT NOT NULL,
    "effectiveMinAmountMinor" BIGINT NOT NULL,
    "effectiveMaxAmountMinor" BIGINT NOT NULL,
    "disclosureVersion" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "paidAt" TIMESTAMP(3),
    "creditedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RechargeOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentIntent" (
    "id" UUID NOT NULL,
    "rechargeOrderId" UUID NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "status" TEXT NOT NULL,
    "activeAttemptId" UUID,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentIntent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentAttempt" (
    "id" UUID NOT NULL,
    "paymentIntentId" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "providerAccountKey" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "providerPaymentId" TEXT,
    "providerOrderId" TEXT,
    "providerCaptureId" TEXT,
    "requestIdempotencyKey" TEXT NOT NULL,
    "actionType" TEXT NOT NULL,
    "actionPayload" TEXT,
    "lastErrorCode" TEXT,
    "lastErrorSafeMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "PaymentAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentEvent" (
    "id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "providerAccountKey" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "verificationMethod" TEXT NOT NULL,
    "paymentAttemptId" UUID,
    "providerPaymentId" TEXT,
    "providerCaptureId" TEXT,
    "providerEventId" TEXT,
    "dedupeKey" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payloadSha256" CHAR(64) NOT NULL,
    "rawPayloadEncrypted" TEXT,
    "normalizedPayload" JSONB NOT NULL,
    "signatureVerified" BOOLEAN,
    "status" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseToken" UUID,
    "leaseUntil" TIMESTAMP(3),
    "observedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "lastErrorCode" TEXT,

    CONSTRAINT "PaymentEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RechargeCredit" (
    "id" UUID NOT NULL,
    "rechargeOrderId" UUID NOT NULL,
    "paymentIntentId" UUID NOT NULL,
    "userId" INTEGER NOT NULL,
    "points" BIGINT NOT NULL,
    "balanceBefore" INTEGER NOT NULL,
    "balanceAfter" INTEGER NOT NULL,
    "businessEventKey" TEXT NOT NULL,
    "pointLogId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reversedAt" TIMESTAMP(3),

    CONSTRAINT "RechargeCredit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RechargeRefund" (
    "id" UUID NOT NULL,
    "rechargeOrderId" UUID NOT NULL,
    "paymentAttemptId" UUID NOT NULL,
    "providerRefundId" TEXT,
    "requestIdempotencyKey" TEXT NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "pointsToReverse" BIGINT NOT NULL,
    "status" TEXT NOT NULL,
    "reasonCode" TEXT NOT NULL,
    "createdByUserId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "RechargeRefund_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PointHold" (
    "id" UUID NOT NULL,
    "userId" INTEGER NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" UUID NOT NULL,
    "points" BIGINT NOT NULL,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PointHold_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RechargeReversal" (
    "id" UUID NOT NULL,
    "rechargeRefundId" UUID NOT NULL,
    "rechargeCreditId" UUID NOT NULL,
    "userId" INTEGER NOT NULL,
    "points" BIGINT NOT NULL,
    "balanceBefore" INTEGER NOT NULL,
    "balanceAfter" INTEGER NOT NULL,
    "businessEventKey" TEXT NOT NULL,
    "pointLogId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RechargeReversal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentDispute" (
    "id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "providerAccountKey" TEXT NOT NULL,
    "providerDisputeId" TEXT NOT NULL,
    "rechargeOrderId" UUID NOT NULL,
    "paymentAttemptId" UUID,
    "amountMinor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "status" TEXT NOT NULL,
    "reasonCode" TEXT,
    "evidenceDueAt" TIMESTAMP(3),
    "openedAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentDispute_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentRecoveryCase" (
    "id" UUID NOT NULL,
    "paymentDisputeId" UUID NOT NULL,
    "rechargeCreditId" UUID NOT NULL,
    "userId" INTEGER NOT NULL,
    "pointsToRecover" BIGINT NOT NULL,
    "pointsHeld" BIGINT NOT NULL,
    "outstandingPoints" BIGINT NOT NULL,
    "lossAmountMinor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "status" TEXT NOT NULL,
    "resolutionReason" TEXT,
    "resolvedByUserId" INTEGER,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentRecoveryCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountRestriction" (
    "id" UUID NOT NULL,
    "userId" INTEGER NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" UUID NOT NULL,
    "blocksPointSpending" BOOLEAN NOT NULL,
    "blocksRecharge" BOOLEAN NOT NULL,
    "status" TEXT NOT NULL,
    "releasedByUserId" INTEGER,
    "releasedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountRestriction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReconciliationRun" (
    "id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "providerAccountKey" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "scopeType" TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3),
    "periodEnd" TIMESTAMP(3),
    "status" TEXT NOT NULL,
    "sourceSha256" CHAR(64),
    "itemCount" INTEGER NOT NULL DEFAULT 0,
    "mismatchCount" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdByUserId" INTEGER,
    "lastErrorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReconciliationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReconciliationItem" (
    "id" UUID NOT NULL,
    "reconciliationRunId" UUID NOT NULL,
    "providerEntryKey" TEXT NOT NULL,
    "rechargeOrderId" UUID,
    "paymentAttemptId" UUID,
    "paymentEventId" UUID,
    "mismatchType" TEXT NOT NULL,
    "providerStatus" TEXT,
    "localStatus" TEXT,
    "providerAmountMinor" BIGINT,
    "localAmountMinor" BIGINT,
    "currency" CHAR(3),
    "status" TEXT NOT NULL,
    "resolutionReason" TEXT,
    "resolvedByUserId" INTEGER,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReconciliationItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RechargeLimitBucket" (
    "id" UUID NOT NULL,
    "userId" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "periodType" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "reservedMinor" BIGINT NOT NULL,
    "consumedMinor" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RechargeLimitBucket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RechargeLimitReservation" (
    "id" UUID NOT NULL,
    "rechargeOrderId" UUID NOT NULL,
    "bucketId" UUID NOT NULL,
    "periodType" TEXT NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "status" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RechargeLimitReservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RechargeCreditTask" (
    "id" UUID NOT NULL,
    "rechargeOrderId" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 8,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseToken" UUID,
    "leaseUntil" TIMESTAMP(3),
    "lastErrorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "RechargeCreditTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RechargeIdempotencyRecord" (
    "id" UUID NOT NULL,
    "userId" INTEGER NOT NULL,
    "scope" TEXT NOT NULL,
    "key" UUID NOT NULL,
    "requestDigest" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "claimToken" UUID NOT NULL,
    "resultType" TEXT NOT NULL,
    "resultId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RechargeIdempotencyRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RechargePricePolicy_code_key" ON "RechargePricePolicy"("code");

-- CreateIndex
CREATE INDEX "RechargePricePolicy_currency_status_idx" ON "RechargePricePolicy"("currency", "status");

-- CreateIndex
CREATE UNIQUE INDEX "RechargePricePolicy_currency_version_key" ON "RechargePricePolicy"("currency", "version");

-- CreateIndex
CREATE INDEX "RechargeSuggestedAmount_policyId_sortOrder_idx" ON "RechargeSuggestedAmount"("policyId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "RechargeSuggestedAmount_policyId_amountMinor_key" ON "RechargeSuggestedAmount"("policyId", "amountMinor");

-- CreateIndex
CREATE INDEX "RechargeQuote_userId_expiresAt_idx" ON "RechargeQuote"("userId", "expiresAt");

-- CreateIndex
CREATE INDEX "RechargeQuote_pricePolicyId_idx" ON "RechargeQuote"("pricePolicyId");

-- CreateIndex
CREATE UNIQUE INDEX "RechargeOrder_quoteId_key" ON "RechargeOrder"("quoteId");

-- CreateIndex
CREATE INDEX "RechargeOrder_userId_createdAt_idx" ON "RechargeOrder"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "RechargeOrder_status_creditedAt_updatedAt_idx" ON "RechargeOrder"("status", "creditedAt", "updatedAt");

-- CreateIndex
CREATE INDEX "RechargeOrder_provider_providerAccountKey_status_idx" ON "RechargeOrder"("provider", "providerAccountKey", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentIntent_rechargeOrderId_key" ON "PaymentIntent"("rechargeOrderId");

-- CreateIndex
CREATE INDEX "PaymentIntent_status_expiresAt_idx" ON "PaymentIntent"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "PaymentAttempt_paymentIntentId_status_idx" ON "PaymentAttempt"("paymentIntentId", "status");

-- CreateIndex
CREATE INDEX "PaymentAttempt_provider_providerAccountKey_status_idx" ON "PaymentAttempt"("provider", "providerAccountKey", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentAttempt_provider_providerAccountKey_requestIdempoten_key" ON "PaymentAttempt"("provider", "providerAccountKey", "requestIdempotencyKey");

-- CreateIndex
CREATE INDEX "PaymentEvent_status_nextAttemptAt_idx" ON "PaymentEvent"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "PaymentEvent_paymentAttemptId_idx" ON "PaymentEvent"("paymentAttemptId");

-- CreateIndex
CREATE INDEX "PaymentEvent_provider_providerPaymentId_idx" ON "PaymentEvent"("provider", "providerPaymentId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentEvent_provider_providerAccountKey_dedupeKey_key" ON "PaymentEvent"("provider", "providerAccountKey", "dedupeKey");

-- CreateIndex
CREATE UNIQUE INDEX "RechargeCredit_rechargeOrderId_key" ON "RechargeCredit"("rechargeOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "RechargeCredit_paymentIntentId_key" ON "RechargeCredit"("paymentIntentId");

-- CreateIndex
CREATE UNIQUE INDEX "RechargeCredit_businessEventKey_key" ON "RechargeCredit"("businessEventKey");

-- CreateIndex
CREATE UNIQUE INDEX "RechargeCredit_pointLogId_key" ON "RechargeCredit"("pointLogId");

-- CreateIndex
CREATE INDEX "RechargeCredit_userId_createdAt_idx" ON "RechargeCredit"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "RechargeRefund_rechargeOrderId_key" ON "RechargeRefund"("rechargeOrderId");

-- CreateIndex
CREATE INDEX "RechargeRefund_status_createdAt_idx" ON "RechargeRefund"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "RechargeRefund_rechargeOrderId_requestIdempotencyKey_key" ON "RechargeRefund"("rechargeOrderId", "requestIdempotencyKey");

-- CreateIndex
CREATE INDEX "PointHold_userId_status_idx" ON "PointHold"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PointHold_sourceType_sourceId_key" ON "PointHold"("sourceType", "sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "RechargeReversal_rechargeRefundId_key" ON "RechargeReversal"("rechargeRefundId");

-- CreateIndex
CREATE UNIQUE INDEX "RechargeReversal_rechargeCreditId_key" ON "RechargeReversal"("rechargeCreditId");

-- CreateIndex
CREATE UNIQUE INDEX "RechargeReversal_businessEventKey_key" ON "RechargeReversal"("businessEventKey");

-- CreateIndex
CREATE UNIQUE INDEX "RechargeReversal_pointLogId_key" ON "RechargeReversal"("pointLogId");

-- CreateIndex
CREATE INDEX "PaymentDispute_status_evidenceDueAt_idx" ON "PaymentDispute"("status", "evidenceDueAt");

-- CreateIndex
CREATE INDEX "PaymentDispute_rechargeOrderId_idx" ON "PaymentDispute"("rechargeOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentDispute_provider_providerAccountKey_providerDisputeI_key" ON "PaymentDispute"("provider", "providerAccountKey", "providerDisputeId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentRecoveryCase_paymentDisputeId_key" ON "PaymentRecoveryCase"("paymentDisputeId");

-- CreateIndex
CREATE INDEX "PaymentRecoveryCase_userId_status_idx" ON "PaymentRecoveryCase"("userId", "status");

-- CreateIndex
CREATE INDEX "AccountRestriction_userId_status_idx" ON "AccountRestriction"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "AccountRestriction_sourceType_sourceId_key" ON "AccountRestriction"("sourceType", "sourceId");

-- CreateIndex
CREATE INDEX "ReconciliationRun_status_createdAt_idx" ON "ReconciliationRun"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ReconciliationRun_provider_providerAccountKey_environment_s_key" ON "ReconciliationRun"("provider", "providerAccountKey", "environment", "scopeType", "scopeKey");

-- CreateIndex
CREATE INDEX "ReconciliationItem_status_mismatchType_idx" ON "ReconciliationItem"("status", "mismatchType");

-- CreateIndex
CREATE INDEX "ReconciliationItem_rechargeOrderId_idx" ON "ReconciliationItem"("rechargeOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "ReconciliationItem_reconciliationRunId_providerEntryKey_mis_key" ON "ReconciliationItem"("reconciliationRunId", "providerEntryKey", "mismatchType");

-- CreateIndex
CREATE INDEX "RechargeLimitBucket_userId_currency_periodType_idx" ON "RechargeLimitBucket"("userId", "currency", "periodType");

-- CreateIndex
CREATE UNIQUE INDEX "RechargeLimitBucket_userId_currency_periodType_periodStart_key" ON "RechargeLimitBucket"("userId", "currency", "periodType", "periodStart");

-- CreateIndex
CREATE INDEX "RechargeLimitReservation_bucketId_status_idx" ON "RechargeLimitReservation"("bucketId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "RechargeLimitReservation_rechargeOrderId_periodType_key" ON "RechargeLimitReservation"("rechargeOrderId", "periodType");

-- CreateIndex
CREATE UNIQUE INDEX "RechargeCreditTask_rechargeOrderId_key" ON "RechargeCreditTask"("rechargeOrderId");

-- CreateIndex
CREATE INDEX "RechargeCreditTask_status_nextAttemptAt_idx" ON "RechargeCreditTask"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "RechargeIdempotencyRecord_expiresAt_idx" ON "RechargeIdempotencyRecord"("expiresAt");

-- CreateIndex
CREATE INDEX "RechargeIdempotencyRecord_status_expiresAt_idx" ON "RechargeIdempotencyRecord"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "RechargeIdempotencyRecord_userId_scope_key_key" ON "RechargeIdempotencyRecord"("userId", "scope", "key");

-- AddForeignKey
ALTER TABLE "RechargeSuggestedAmount" ADD CONSTRAINT "RechargeSuggestedAmount_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "RechargePricePolicy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RechargeQuote" ADD CONSTRAINT "RechargeQuote_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RechargeQuote" ADD CONSTRAINT "RechargeQuote_pricePolicyId_fkey" FOREIGN KEY ("pricePolicyId") REFERENCES "RechargePricePolicy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RechargeOrder" ADD CONSTRAINT "RechargeOrder_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RechargeOrder" ADD CONSTRAINT "RechargeOrder_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "RechargeQuote"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RechargeOrder" ADD CONSTRAINT "RechargeOrder_pricePolicyId_fkey" FOREIGN KEY ("pricePolicyId") REFERENCES "RechargePricePolicy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentIntent" ADD CONSTRAINT "PaymentIntent_rechargeOrderId_fkey" FOREIGN KEY ("rechargeOrderId") REFERENCES "RechargeOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentAttempt" ADD CONSTRAINT "PaymentAttempt_paymentIntentId_fkey" FOREIGN KEY ("paymentIntentId") REFERENCES "PaymentIntent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentEvent" ADD CONSTRAINT "PaymentEvent_paymentAttemptId_fkey" FOREIGN KEY ("paymentAttemptId") REFERENCES "PaymentAttempt"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RechargeCredit" ADD CONSTRAINT "RechargeCredit_rechargeOrderId_fkey" FOREIGN KEY ("rechargeOrderId") REFERENCES "RechargeOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RechargeCredit" ADD CONSTRAINT "RechargeCredit_paymentIntentId_fkey" FOREIGN KEY ("paymentIntentId") REFERENCES "PaymentIntent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RechargeCredit" ADD CONSTRAINT "RechargeCredit_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RechargeCredit" ADD CONSTRAINT "RechargeCredit_pointLogId_fkey" FOREIGN KEY ("pointLogId") REFERENCES "PointLog"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RechargeRefund" ADD CONSTRAINT "RechargeRefund_rechargeOrderId_fkey" FOREIGN KEY ("rechargeOrderId") REFERENCES "RechargeOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RechargeRefund" ADD CONSTRAINT "RechargeRefund_paymentAttemptId_fkey" FOREIGN KEY ("paymentAttemptId") REFERENCES "PaymentAttempt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RechargeRefund" ADD CONSTRAINT "RechargeRefund_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PointHold" ADD CONSTRAINT "PointHold_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RechargeReversal" ADD CONSTRAINT "RechargeReversal_rechargeRefundId_fkey" FOREIGN KEY ("rechargeRefundId") REFERENCES "RechargeRefund"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RechargeReversal" ADD CONSTRAINT "RechargeReversal_rechargeCreditId_fkey" FOREIGN KEY ("rechargeCreditId") REFERENCES "RechargeCredit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RechargeReversal" ADD CONSTRAINT "RechargeReversal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RechargeReversal" ADD CONSTRAINT "RechargeReversal_pointLogId_fkey" FOREIGN KEY ("pointLogId") REFERENCES "PointLog"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentDispute" ADD CONSTRAINT "PaymentDispute_rechargeOrderId_fkey" FOREIGN KEY ("rechargeOrderId") REFERENCES "RechargeOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentDispute" ADD CONSTRAINT "PaymentDispute_paymentAttemptId_fkey" FOREIGN KEY ("paymentAttemptId") REFERENCES "PaymentAttempt"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentRecoveryCase" ADD CONSTRAINT "PaymentRecoveryCase_paymentDisputeId_fkey" FOREIGN KEY ("paymentDisputeId") REFERENCES "PaymentDispute"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentRecoveryCase" ADD CONSTRAINT "PaymentRecoveryCase_rechargeCreditId_fkey" FOREIGN KEY ("rechargeCreditId") REFERENCES "RechargeCredit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentRecoveryCase" ADD CONSTRAINT "PaymentRecoveryCase_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentRecoveryCase" ADD CONSTRAINT "PaymentRecoveryCase_resolvedByUserId_fkey" FOREIGN KEY ("resolvedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountRestriction" ADD CONSTRAINT "AccountRestriction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountRestriction" ADD CONSTRAINT "AccountRestriction_releasedByUserId_fkey" FOREIGN KEY ("releasedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReconciliationRun" ADD CONSTRAINT "ReconciliationRun_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReconciliationItem" ADD CONSTRAINT "ReconciliationItem_reconciliationRunId_fkey" FOREIGN KEY ("reconciliationRunId") REFERENCES "ReconciliationRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReconciliationItem" ADD CONSTRAINT "ReconciliationItem_rechargeOrderId_fkey" FOREIGN KEY ("rechargeOrderId") REFERENCES "RechargeOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReconciliationItem" ADD CONSTRAINT "ReconciliationItem_paymentAttemptId_fkey" FOREIGN KEY ("paymentAttemptId") REFERENCES "PaymentAttempt"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReconciliationItem" ADD CONSTRAINT "ReconciliationItem_paymentEventId_fkey" FOREIGN KEY ("paymentEventId") REFERENCES "PaymentEvent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReconciliationItem" ADD CONSTRAINT "ReconciliationItem_resolvedByUserId_fkey" FOREIGN KEY ("resolvedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RechargeLimitBucket" ADD CONSTRAINT "RechargeLimitBucket_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RechargeLimitReservation" ADD CONSTRAINT "RechargeLimitReservation_rechargeOrderId_fkey" FOREIGN KEY ("rechargeOrderId") REFERENCES "RechargeOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RechargeLimitReservation" ADD CONSTRAINT "RechargeLimitReservation_bucketId_fkey" FOREIGN KEY ("bucketId") REFERENCES "RechargeLimitBucket"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RechargeCreditTask" ADD CONSTRAINT "RechargeCreditTask_rechargeOrderId_fkey" FOREIGN KEY ("rechargeOrderId") REFERENCES "RechargeOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RechargeIdempotencyRecord" ADD CONSTRAINT "RechargeIdempotencyRecord_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Fail-closed PointAccount hard-cap. Scan is read-only: never rewrite balances.
DO $$
DECLARE
  violating_count integer;
  diagnostic text;
BEGIN
  SELECT COUNT(*) INTO violating_count
  FROM "PointAccount"
  WHERE "balance" < 0
     OR "frozenBalance" < 0
     OR ("balance"::bigint + "frozenBalance"::bigint) > 2000000000;

  IF violating_count > 0 THEN
    SELECT string_agg(
      format('userId=%s balance=%s frozen=%s total=%s',
        "userId", "balance", "frozenBalance",
        ("balance"::bigint + "frozenBalance"::bigint)),
      '; '
    )
    INTO diagnostic
    FROM (
      SELECT "userId", "balance", "frozenBalance"
      FROM "PointAccount"
      WHERE "balance" < 0
         OR "frozenBalance" < 0
         OR ("balance"::bigint + "frozenBalance"::bigint) > 2000000000
      ORDER BY "userId"
      LIMIT 20
    ) AS offenders;

    RAISE NOTICE 'FAIL CLOSED point_account_hard_cap_2000000000: % violating PointAccount row(s): %',
      violating_count, diagnostic;
    RAISE EXCEPTION
      'FAIL CLOSED: cannot add point_account_hard_cap_2000000000; % violating PointAccount row(s): %',
      violating_count, diagnostic;
  END IF;
END $$;

ALTER TABLE "PointAccount"
  ADD CONSTRAINT "point_account_hard_cap_2000000000"
  CHECK (
    "balance" >= 0
    AND "frozenBalance" >= 0
    AND ("balance"::bigint + "frozenBalance"::bigint) <= 2000000000
  );

ALTER TABLE "RechargePricePolicy"
  ADD CONSTRAINT "RechargePricePolicy_currency_check"
    CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "RechargePricePolicy_status_check"
    CHECK ("status" IN ('draft', 'active', 'retired')),
  ADD CONSTRAINT "RechargePricePolicy_limitTimeZone_check"
    CHECK (char_length("limitTimeZone") > 0),
  ADD CONSTRAINT "RechargePricePolicy_amounts_check"
    CHECK (
      "pointsNumerator" > 0
      AND "pointsDenominator" > 0
      AND "currencyScale" > 0
      AND "minAmountMinor" >= 0
      AND "maxAmountMinor" >= "minAmountMinor"
      AND "amountStepMinor" > 0
      AND "dailyLimitMinor" >= "maxAmountMinor"
      AND "monthlyLimitMinor" >= "dailyLimitMinor"
    );

ALTER TABLE "RechargeSuggestedAmount"
  ADD CONSTRAINT "RechargeSuggestedAmount_amounts_check"
    CHECK ("amountMinor" >= 0 AND "sortOrder" >= 0);

ALTER TABLE "RechargeQuote"
  ADD CONSTRAINT "RechargeQuote_currency_check"
    CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "RechargeQuote_amountSource_check"
    CHECK ("amountSource" IN ('suggested', 'custom')),
  ADD CONSTRAINT "RechargeQuote_amounts_check"
    CHECK (
      "amountMinor" >= 0
      AND "effectiveMinAmountMinor" >= 0
      AND "effectiveMaxAmountMinor" >= "effectiveMinAmountMinor"
      AND "basePoints" >= 0
      AND "bonusPoints" >= 0
      AND "totalPoints" = "basePoints" + "bonusPoints"
    );

ALTER TABLE "RechargeOrder"
  ADD CONSTRAINT "RechargeOrder_currency_check"
    CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "RechargeOrder_status_check"
    CHECK ("status" IN (
      'created', 'pending_payment', 'closure_pending', 'paid', 'credited',
      'failed', 'expired', 'cancelled', 'refund_pending', 'refunded', 'reconcile_required'
    )),
  ADD CONSTRAINT "RechargeOrder_amountSource_check"
    CHECK ("amountSource" IN ('suggested', 'custom')),
  ADD CONSTRAINT "RechargeOrder_amounts_check"
    CHECK (
      "amountMinor" >= 0
      AND "basePoints" >= 0
      AND "bonusPoints" >= 0
      AND "totalPoints" = "basePoints" + "bonusPoints"
      AND "pointsNumerator" > 0
      AND "pointsDenominator" > 0
      AND "currencyScale" > 0
      AND "effectiveMinAmountMinor" >= 0
      AND "effectiveMaxAmountMinor" >= "effectiveMinAmountMinor"
    );

ALTER TABLE "PaymentIntent"
  ADD CONSTRAINT "PaymentIntent_currency_check"
    CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "PaymentIntent_status_check"
    CHECK ("status" IN (
      'requires_method', 'processing', 'succeeded', 'failed', 'cancelled', 'reconcile_required'
    )),
  ADD CONSTRAINT "PaymentIntent_amount_check"
    CHECK ("amountMinor" >= 0);

ALTER TABLE "PaymentAttempt"
  ADD CONSTRAINT "PaymentAttempt_status_check"
    CHECK ("status" IN (
      'created', 'requires_action', 'processing', 'succeeded', 'failed', 'cancelled', 'unknown'
    )),
  ADD CONSTRAINT "PaymentAttempt_actionType_check"
    CHECK ("actionType" IN ('none', 'redirect', 'qr_code', 'client_secret', 'form_post'));

ALTER TABLE "PaymentEvent"
  ADD CONSTRAINT "PaymentEvent_source_check"
    CHECK ("source" IN ('webhook', 'provider_query', 'provider_complete', 'reconciliation')),
  ADD CONSTRAINT "PaymentEvent_verificationMethod_check"
    CHECK ("verificationMethod" IN ('webhook_signature', 'authenticated_provider_api')),
  ADD CONSTRAINT "PaymentEvent_source_verification_pair_check"
    CHECK (
      ("source" = 'webhook' AND "verificationMethod" = 'webhook_signature')
      OR (
        "source" IN ('provider_query', 'provider_complete', 'reconciliation')
        AND "verificationMethod" = 'authenticated_provider_api'
      )
    ),
  ADD CONSTRAINT "PaymentEvent_status_check"
    CHECK ("status" IN (
      'received', 'processing', 'processed', 'ignored', 'failed', 'reconcile_required'
    )),
  ADD CONSTRAINT "PaymentEvent_dedupeKey_check"
    CHECK (char_length("dedupeKey") > 0),
  ADD CONSTRAINT "PaymentEvent_payloadSha256_check"
    CHECK ("payloadSha256" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "PaymentEvent_attempts_check"
    CHECK ("attempts" >= 0);

ALTER TABLE "RechargeCredit"
  ADD CONSTRAINT "RechargeCredit_points_check"
    CHECK ("points" > 0 AND "balanceBefore" >= 0 AND "balanceAfter" >= 0);

ALTER TABLE "RechargeRefund"
  ADD CONSTRAINT "RechargeRefund_status_check"
    CHECK ("status" IN (
      'requested', 'points_held', 'processing', 'succeeded', 'failed', 'cancelled', 'manual_review'
    )),
  ADD CONSTRAINT "RechargeRefund_amounts_check"
    CHECK ("amountMinor" >= 0 AND "pointsToReverse" >= 0);

ALTER TABLE "PointHold"
  ADD CONSTRAINT "PointHold_sourceType_check"
    CHECK ("sourceType" IN ('recharge_refund', 'payment_dispute')),
  ADD CONSTRAINT "PointHold_status_check"
    CHECK ("status" IN ('active', 'consumed', 'released')),
  ADD CONSTRAINT "PointHold_points_check"
    CHECK ("points" >= 0);

ALTER TABLE "RechargeReversal"
  ADD CONSTRAINT "RechargeReversal_points_check"
    CHECK ("points" > 0 AND "balanceBefore" >= 0 AND "balanceAfter" >= 0);

ALTER TABLE "PaymentDispute"
  ADD CONSTRAINT "PaymentDispute_status_check"
    CHECK ("status" IN ('open', 'won', 'lost', 'closed')),
  ADD CONSTRAINT "PaymentDispute_currency_check"
    CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "PaymentDispute_amount_check"
    CHECK ("amountMinor" >= 0);

ALTER TABLE "PaymentRecoveryCase"
  ADD CONSTRAINT "PaymentRecoveryCase_status_check"
    CHECK ("status" IN ('open', 'held', 'recovered', 'written_off', 'restored')),
  ADD CONSTRAINT "PaymentRecoveryCase_currency_check"
    CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "PaymentRecoveryCase_amounts_check"
    CHECK (
      "pointsToRecover" >= 0
      AND "pointsHeld" >= 0
      AND "outstandingPoints" >= 0
      AND "lossAmountMinor" >= 0
    );

ALTER TABLE "AccountRestriction"
  ADD CONSTRAINT "AccountRestriction_sourceType_check"
    CHECK ("sourceType" IN ('payment_dispute')),
  ADD CONSTRAINT "AccountRestriction_status_check"
    CHECK ("status" IN ('active', 'released'));

ALTER TABLE "ReconciliationRun"
  ADD CONSTRAINT "ReconciliationRun_environment_check"
    CHECK ("environment" IN ('sandbox', 'live')),
  ADD CONSTRAINT "ReconciliationRun_scopeType_check"
    CHECK ("scopeType" IN ('statement', 'provider_query', 'manual')),
  ADD CONSTRAINT "ReconciliationRun_status_check"
    CHECK ("status" IN (
      'pending', 'running', 'completed', 'completed_with_mismatches', 'failed'
    )),
  ADD CONSTRAINT "ReconciliationRun_counts_check"
    CHECK ("itemCount" >= 0 AND "mismatchCount" >= 0);

ALTER TABLE "ReconciliationItem"
  ADD CONSTRAINT "ReconciliationItem_mismatchType_check"
    CHECK ("mismatchType" IN (
      'provider_paid_local_unpaid',
      'local_paid_provider_not_paid',
      'paid_not_credited',
      'refund_mismatch',
      'amount_mismatch',
      'currency_mismatch',
      'duplicate_provider_payment',
      'unknown_provider_transaction'
    )),
  ADD CONSTRAINT "ReconciliationItem_status_check"
    CHECK ("status" IN ('open', 'resolved', 'ignored')),
  ADD CONSTRAINT "ReconciliationItem_amounts_check"
    CHECK (
      ("providerAmountMinor" IS NULL OR "providerAmountMinor" >= 0)
      AND ("localAmountMinor" IS NULL OR "localAmountMinor" >= 0)
    );

ALTER TABLE "RechargeLimitBucket"
  ADD CONSTRAINT "RechargeLimitBucket_currency_check"
    CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "RechargeLimitBucket_periodType_check"
    CHECK ("periodType" IN ('day', 'month')),
  ADD CONSTRAINT "RechargeLimitBucket_amounts_check"
    CHECK (
      "reservedMinor" >= 0
      AND "consumedMinor" >= 0
      AND "periodEnd" > "periodStart"
    );

ALTER TABLE "RechargeLimitReservation"
  ADD CONSTRAINT "RechargeLimitReservation_periodType_check"
    CHECK ("periodType" IN ('day', 'month')),
  ADD CONSTRAINT "RechargeLimitReservation_status_check"
    CHECK ("status" IN ('reserved', 'consumed', 'released')),
  ADD CONSTRAINT "RechargeLimitReservation_amount_check"
    CHECK ("amountMinor" > 0);

ALTER TABLE "RechargeCreditTask"
  ADD CONSTRAINT "RechargeCreditTask_status_check"
    CHECK ("status" IN (
      'pending', 'processing', 'succeeded', 'failed', 'reconcile_required'
    )),
  ADD CONSTRAINT "RechargeCreditTask_attempts_check"
    CHECK ("attempts" >= 0 AND "maxAttempts" > 0);

ALTER TABLE "RechargeIdempotencyRecord"
  ADD CONSTRAINT "RechargeIdempotencyRecord_scope_check"
    CHECK ("scope" IN ('create_order', 'complete_payment', 'cancel_order', 'request_refund')),
  ADD CONSTRAINT "RechargeIdempotencyRecord_status_check"
    CHECK ("status" IN ('processing', 'completed')),
  ADD CONSTRAINT "RechargeIdempotencyRecord_digest_check"
    CHECK (char_length("requestDigest") > 0);

-- Prisma cannot express these WHERE clauses; replay them here.
CREATE UNIQUE INDEX "recharge_price_policy_one_active_per_currency"
  ON "RechargePricePolicy" ("currency")
  WHERE status = 'active';

CREATE UNIQUE INDEX "PaymentAttempt_provider_account_providerPaymentId_key"
  ON "PaymentAttempt" ("provider", "providerAccountKey", "providerPaymentId")
  WHERE "providerPaymentId" IS NOT NULL;

CREATE UNIQUE INDEX "PaymentAttempt_one_non_terminal_per_intent"
  ON "PaymentAttempt" ("paymentIntentId")
  WHERE status IN ('created', 'requires_action', 'processing', 'unknown');
