-- SPEC-LEGAL-001：协议同意的两层证据表。
-- UserAgreementConsent：长期同意事实（注册双协议），(userId, document, version) 唯一。
-- OrderAgreementAcceptance：订单级确认快照，(orderId, document) 唯一，只插入不更新。
-- 两表 ip/userAgent 由 retentionCron 在 retentionUntil 到期后置空匿名化。

-- CreateTable
CREATE TABLE "UserAgreementConsent" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "document" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "consentedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip" TEXT,
    "userAgent" TEXT,
    "retentionUntil" TIMESTAMP(3),

    CONSTRAINT "UserAgreementConsent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderAgreementAcceptance" (
    "id" SERIAL NOT NULL,
    "orderId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "document" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip" TEXT,
    "userAgent" TEXT,
    "retentionUntil" TIMESTAMP(3),

    CONSTRAINT "OrderAgreementAcceptance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UserAgreementConsent_userId_document_version_key" ON "UserAgreementConsent"("userId", "document", "version");

-- CreateIndex
CREATE INDEX "UserAgreementConsent_retentionUntil_idx" ON "UserAgreementConsent"("retentionUntil");

-- CreateIndex
CREATE UNIQUE INDEX "OrderAgreementAcceptance_orderId_document_key" ON "OrderAgreementAcceptance"("orderId", "document");

-- CreateIndex
CREATE INDEX "OrderAgreementAcceptance_userId_idx" ON "OrderAgreementAcceptance"("userId");

-- CreateIndex
CREATE INDEX "OrderAgreementAcceptance_retentionUntil_idx" ON "OrderAgreementAcceptance"("retentionUntil");

-- AddForeignKey
ALTER TABLE "UserAgreementConsent" ADD CONSTRAINT "UserAgreementConsent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderAgreementAcceptance" ADD CONSTRAINT "OrderAgreementAcceptance_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderAgreementAcceptance" ADD CONSTRAINT "OrderAgreementAcceptance_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
