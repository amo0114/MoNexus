-- CreateTable
CREATE TABLE "XboardInstance" (
    "id" VARCHAR(64) NOT NULL,
    "origin" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "XboardInstance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "XboardAccountLink" (
    "id" UUID NOT NULL,
    "userId" INTEGER NOT NULL,
    "instanceId" VARCHAR(64) NOT NULL,
    "xboardUserId" VARCHAR(19) NOT NULL,
    "currentEmail" TEXT NOT NULL,
    "emailSnapshot" TEXT NOT NULL,
    "sourceOrderId" INTEGER NOT NULL,
    "sourceExternalOrderNo" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "blockReason" TEXT,
    "resolvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "XboardAccountLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "XboardAccountEvidence" (
    "id" UUID NOT NULL,
    "accountLinkId" UUID NOT NULL,
    "userId" INTEGER NOT NULL,
    "sourceOrderId" INTEGER NOT NULL,
    "externalOrderNo" TEXT NOT NULL,
    "emailSnapshot" TEXT NOT NULL,
    "proofKind" TEXT NOT NULL,
    "proofVerifiedAt" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "XboardAccountEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "XboardAccountPreference" (
    "userId" INTEGER NOT NULL,
    "instanceId" VARCHAR(64) NOT NULL,
    "defaultAccountLinkId" UUID NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "XboardAccountPreference_pkey" PRIMARY KEY ("userId","instanceId")
);

-- CreateTable
CREATE TABLE "XboardAccountSelection" (
    "userId" INTEGER NOT NULL,
    "instanceId" VARCHAR(64) NOT NULL,
    "requestId" UUID NOT NULL,
    "accountLinkId" UUID NOT NULL,
    "chatBindingId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "XboardAccountSelection_pkey" PRIMARY KEY ("userId","instanceId","requestId")
);

-- CreateTable
CREATE TABLE "XboardAccountBackfillState" (
    "instanceId" VARCHAR(64) NOT NULL,
    "cursorUserId" INTEGER NOT NULL DEFAULT 0,
    "cursorTaskId" INTEGER NOT NULL DEFAULT 0,
    "cycle" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "XboardAccountBackfillState_pkey" PRIMARY KEY ("instanceId")
);

-- CreateIndex
CREATE INDEX "XboardAccountLink_userId_instanceId_status_idx" ON "XboardAccountLink"("userId", "instanceId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "XboardAccountLink_instanceId_xboardUserId_key" ON "XboardAccountLink"("instanceId", "xboardUserId");

-- CreateIndex
CREATE UNIQUE INDEX "XboardAccountLink_id_userId_instanceId_key" ON "XboardAccountLink"("id", "userId", "instanceId");

-- CreateIndex
CREATE UNIQUE INDEX "XboardAccountEvidence_sourceOrderId_key" ON "XboardAccountEvidence"("sourceOrderId");

-- AddForeignKey
ALTER TABLE "XboardAccountLink" ADD CONSTRAINT "XboardAccountLink_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "XboardAccountLink" ADD CONSTRAINT "XboardAccountLink_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "XboardInstance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "XboardAccountLink" ADD CONSTRAINT "XboardAccountLink_sourceOrderId_fkey" FOREIGN KEY ("sourceOrderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "XboardAccountEvidence" ADD CONSTRAINT "XboardAccountEvidence_accountLinkId_fkey" FOREIGN KEY ("accountLinkId") REFERENCES "XboardAccountLink"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "XboardAccountEvidence" ADD CONSTRAINT "XboardAccountEvidence_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "XboardAccountEvidence" ADD CONSTRAINT "XboardAccountEvidence_sourceOrderId_fkey" FOREIGN KEY ("sourceOrderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "XboardAccountPreference" ADD CONSTRAINT "XboardAccountPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "XboardAccountPreference" ADD CONSTRAINT "XboardAccountPreference_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "XboardInstance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "XboardAccountPreference" ADD CONSTRAINT "XboardAccountPreference_defaultAccountLinkId_userId_instan_fkey" FOREIGN KEY ("defaultAccountLinkId", "userId", "instanceId") REFERENCES "XboardAccountLink"("id", "userId", "instanceId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "XboardAccountSelection" ADD CONSTRAINT "XboardAccountSelection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "XboardAccountSelection" ADD CONSTRAINT "XboardAccountSelection_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "XboardInstance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "XboardAccountSelection" ADD CONSTRAINT "XboardAccountSelection_accountLinkId_userId_instanceId_fkey" FOREIGN KEY ("accountLinkId", "userId", "instanceId") REFERENCES "XboardAccountLink"("id", "userId", "instanceId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "XboardAccountBackfillState" ADD CONSTRAINT "XboardAccountBackfillState_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "XboardInstance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "XboardAccountLink" ADD CONSTRAINT "XboardAccountLink_status_check"
  CHECK ("status" IN ('active','blocked','unresolved'));
ALTER TABLE "XboardAccountLink" ADD CONSTRAINT "XboardAccountLink_remote_id_check"
  CHECK ("xboardUserId" ~ '^[1-9][0-9]{0,18}$' AND "xboardUserId"::numeric <= 9223372036854775807);
ALTER TABLE "XboardAccountEvidence" ADD CONSTRAINT "XboardAccountEvidence_proof_check"
  CHECK ("proofKind" IN ('email_proof','verified_account_email'));
ALTER TABLE "XboardAccountBackfillState" ADD CONSTRAINT "XboardAccountBackfillState_cursor_check"
  CHECK ("cursorUserId" >= 0 AND "cursorTaskId" >= 0 AND "cycle" >= 0);
