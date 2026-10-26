-- CreateTable
CREATE TABLE "TrafficResetBenefitGrant" (
    "id" UUID NOT NULL,
    "userId" INTEGER NOT NULL,
    "benefitCode" TEXT NOT NULL DEFAULT 'welcome_traffic_reset_v1',
    "granted" INTEGER NOT NULL DEFAULT 1,
    "reserved" INTEGER NOT NULL DEFAULT 0,
    "consumed" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'active',
    "sourceOrderId" INTEGER NOT NULL,
    "revokedReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrafficResetBenefitGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrafficResetIntent" (
    "id" UUID NOT NULL,
    "userId" INTEGER NOT NULL,
    "chatBindingId" INTEGER NOT NULL,
    "accountLinkId" UUID NOT NULL,
    "benefitGrantId" UUID NOT NULL,
    "instanceIdSnapshot" VARCHAR(64) NOT NULL,
    "tokenHash" VARCHAR(64) NOT NULL,
    "keyId" VARCHAR(16) NOT NULL,
    "expectedPlanId" VARCHAR(19) NOT NULL,
    "expectedFingerprint" VARCHAR(64) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "requestId" UUID NOT NULL,
    "requestHash" VARCHAR(64) NOT NULL,
    "requestedAccountLinkId" UUID,
    "failedAttempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrafficResetIntent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrafficResetConfirmationRequest" (
    "userId" INTEGER NOT NULL,
    "requestId" UUID NOT NULL,
    "requestHash" VARCHAR(64) NOT NULL,
    "operationId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrafficResetConfirmationRequest_pkey" PRIMARY KEY ("userId","requestId")
);

-- CreateTable
CREATE TABLE "XboardTrafficResetOperation" (
    "id" UUID NOT NULL,
    "userId" INTEGER NOT NULL,
    "intentId" UUID NOT NULL,
    "benefitGrantId" UUID NOT NULL,
    "accountLinkId" UUID NOT NULL,
    "instanceIdSnapshot" VARCHAR(64) NOT NULL,
    "originSnapshot" TEXT NOT NULL,
    "clientIdSnapshot" VARCHAR(64) NOT NULL,
    "xboardUserIdSnapshot" VARCHAR(19) NOT NULL,
    "benefitCodeSnapshot" TEXT NOT NULL,
    "sourceOrderId" INTEGER NOT NULL,
    "expectedPlanId" VARCHAR(19) NOT NULL,
    "expectedFingerprint" VARCHAR(64) NOT NULL,
    "requestId" UUID NOT NULL,
    "requestHash" VARCHAR(64) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "cancelRequested" BOOLEAN NOT NULL DEFAULT false,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseUntil" TIMESTAMP(3),
    "leaseToken" UUID,
    "reservationApplied" BOOLEAN NOT NULL DEFAULT true,
    "consumptionApplied" BOOLEAN NOT NULL DEFAULT false,
    "beforeSnapshot" JSONB,
    "afterSnapshot" JSONB,
    "errorCode" TEXT,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "XboardTrafficResetOperation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TrafficResetBenefitGrant_userId_benefitCode_key" ON "TrafficResetBenefitGrant"("userId", "benefitCode");

-- CreateIndex
CREATE INDEX "TrafficResetIntent_expiresAt_idx" ON "TrafficResetIntent"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "TrafficResetIntent_userId_requestId_key" ON "TrafficResetIntent"("userId", "requestId");

-- CreateIndex
CREATE UNIQUE INDEX "XboardTrafficResetOperation_intentId_key" ON "XboardTrafficResetOperation"("intentId");

-- CreateIndex
CREATE INDEX "XboardTrafficResetOperation_status_nextAttemptAt_leaseUntil_idx" ON "XboardTrafficResetOperation"("status", "nextAttemptAt", "leaseUntil");

-- CreateIndex
CREATE UNIQUE INDEX "XboardTrafficResetOperation_userId_requestId_key" ON "XboardTrafficResetOperation"("userId", "requestId");

-- AddForeignKey
ALTER TABLE "TrafficResetBenefitGrant" ADD CONSTRAINT "TrafficResetBenefitGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrafficResetBenefitGrant" ADD CONSTRAINT "TrafficResetBenefitGrant_sourceOrderId_fkey" FOREIGN KEY ("sourceOrderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrafficResetIntent" ADD CONSTRAINT "TrafficResetIntent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrafficResetIntent" ADD CONSTRAINT "TrafficResetIntent_benefitGrantId_fkey" FOREIGN KEY ("benefitGrantId") REFERENCES "TrafficResetBenefitGrant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrafficResetIntent" ADD CONSTRAINT "TrafficResetIntent_accountLinkId_fkey" FOREIGN KEY ("accountLinkId") REFERENCES "XboardAccountLink"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrafficResetConfirmationRequest" ADD CONSTRAINT "TrafficResetConfirmationRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrafficResetConfirmationRequest" ADD CONSTRAINT "TrafficResetConfirmationRequest_operationId_fkey" FOREIGN KEY ("operationId") REFERENCES "XboardTrafficResetOperation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "XboardTrafficResetOperation" ADD CONSTRAINT "XboardTrafficResetOperation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "XboardTrafficResetOperation" ADD CONSTRAINT "XboardTrafficResetOperation_intentId_fkey" FOREIGN KEY ("intentId") REFERENCES "TrafficResetIntent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "XboardTrafficResetOperation" ADD CONSTRAINT "XboardTrafficResetOperation_benefitGrantId_fkey" FOREIGN KEY ("benefitGrantId") REFERENCES "TrafficResetBenefitGrant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "XboardTrafficResetOperation" ADD CONSTRAINT "XboardTrafficResetOperation_accountLinkId_fkey" FOREIGN KEY ("accountLinkId") REFERENCES "XboardAccountLink"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "XboardTrafficResetOperation" ADD CONSTRAINT "XboardTrafficResetOperation_sourceOrderId_fkey" FOREIGN KEY ("sourceOrderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "TrafficResetBenefitGrant" ADD CONSTRAINT "traffic_reset_balance_check"
 CHECK ("benefitCode" = 'welcome_traffic_reset_v1' AND "granted" = 1 AND "reserved" >= 0 AND "consumed" >= 0 AND "reserved" + "consumed" <= "granted" AND "version" >= 0);
ALTER TABLE "TrafficResetBenefitGrant" ADD CONSTRAINT "traffic_reset_grant_status_check"
 CHECK ("status" IN ('active','revoked','pending_verification'));
ALTER TABLE "TrafficResetIntent" ADD CONSTRAINT "traffic_reset_intent_attempts_check" CHECK ("failedAttempts" BETWEEN 0 AND 5);
ALTER TABLE "XboardTrafficResetOperation" ADD CONSTRAINT "traffic_reset_operation_status_check"
 CHECK ("status" IN ('queued','sending','needs_reconcile','succeeded','failed','cancelled') AND "attempts" >= 0);
ALTER TABLE "XboardTrafficResetOperation" ADD CONSTRAINT "traffic_reset_operation_balance_check"
 CHECK (("status" IN ('queued','sending','needs_reconcile') AND "reservationApplied" AND NOT "consumptionApplied")
   OR ("status" = 'succeeded' AND NOT "reservationApplied" AND "consumptionApplied")
   OR ("status" IN ('failed','cancelled') AND NOT "reservationApplied" AND NOT "consumptionApplied"));
