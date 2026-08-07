-- CreateTable
CREATE TABLE "Notification" (
    "id" SERIAL NOT NULL,
    "recipientUserId" INTEGER NOT NULL,
    "recipientRole" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "payload" JSONB,
    "deeplink" TEXT NOT NULL,
    "level" TEXT NOT NULL DEFAULT 'info',
    "status" TEXT NOT NULL DEFAULT 'unread',
    "dedupeKey" TEXT NOT NULL,
    "relatedOrderId" INTEGER,
    "relatedMerchantId" INTEGER,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Notification_recipientUserId_status_createdAt_idx" ON "Notification"("recipientUserId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_relatedOrderId_idx" ON "Notification"("relatedOrderId");

-- CreateIndex
CREATE INDEX "Notification_expiresAt_idx" ON "Notification"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "Notification_recipientUserId_eventType_dedupeKey_key" ON "Notification"("recipientUserId", "eventType", "dedupeKey");

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_recipientUserId_fkey" FOREIGN KEY ("recipientUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
