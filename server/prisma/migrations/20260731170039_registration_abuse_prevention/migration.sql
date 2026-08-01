-- AlterTable
ALTER TABLE "InviteRelation" ADD COLUMN     "qualificationDay" TEXT,
ADD COLUMN     "qualifiedAt" TIMESTAMP(3),
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'legacy',
ADD COLUMN     "voidedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "referralSuspended" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "GrowthReward" (
    "id" SERIAL NOT NULL,
    "recipientUserId" INTEGER NOT NULL,
    "inviteRelationId" INTEGER,
    "kind" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'pending_verification',
    "availableAt" TIMESTAMP(3),
    "grantedAt" TIMESTAMP(3),
    "voidedAt" TIMESTAMP(3),
    "voidReason" TEXT,
    "dedupeKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GrowthReward_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AbuseEvent" (
    "id" SERIAL NOT NULL,
    "type" TEXT NOT NULL,
    "userId" INTEGER,
    "inviterId" INTEGER,
    "inviteeId" INTEGER,
    "ipHash" TEXT,
    "emailHash" TEXT,
    "detailSafe" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AbuseEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GrowthReward_inviteRelationId_key" ON "GrowthReward"("inviteRelationId");

-- CreateIndex
CREATE UNIQUE INDEX "GrowthReward_dedupeKey_key" ON "GrowthReward"("dedupeKey");

-- CreateIndex
CREATE INDEX "GrowthReward_state_availableAt_idx" ON "GrowthReward"("state", "availableAt");

-- CreateIndex
CREATE INDEX "GrowthReward_recipientUserId_state_createdAt_idx" ON "GrowthReward"("recipientUserId", "state", "createdAt");

-- CreateIndex
CREATE INDEX "AbuseEvent_type_createdAt_idx" ON "AbuseEvent"("type", "createdAt");

-- CreateIndex
CREATE INDEX "AbuseEvent_inviterId_createdAt_idx" ON "AbuseEvent"("inviterId", "createdAt");

-- CreateIndex
CREATE INDEX "InviteRelation_inviterId_status_qualifiedAt_idx" ON "InviteRelation"("inviterId", "status", "qualifiedAt");

-- CreateIndex
CREATE INDEX "InviteRelation_inviterId_status_qualificationDay_idx" ON "InviteRelation"("inviterId", "status", "qualificationDay");

-- AddForeignKey
ALTER TABLE "GrowthReward" ADD CONSTRAINT "GrowthReward_recipientUserId_fkey" FOREIGN KEY ("recipientUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GrowthReward" ADD CONSTRAINT "GrowthReward_inviteRelationId_fkey" FOREIGN KEY ("inviteRelationId") REFERENCES "InviteRelation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AbuseEvent" ADD CONSTRAINT "AbuseEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AbuseEvent" ADD CONSTRAINT "AbuseEvent_inviterId_fkey" FOREIGN KEY ("inviterId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AbuseEvent" ADD CONSTRAINT "AbuseEvent_inviteeId_fkey" FOREIGN KEY ("inviteeId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
