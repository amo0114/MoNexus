-- P5 T2: file-delivery data model.
-- 1) Offer.fixedFileId — the file currently on sale for fixedContentType='file'
--    offers. Only a pointer to "what new orders get"; never consulted for
--    downloads of existing orders.
-- 2) DeliveryRecord.fileId — the per-order frozen file reference, written in
--    the order-creation transaction (fixed-file offers) or at delivery time
--    (manual attachments). Download authorization reads ONLY this snapshot.
-- 3) FileGrantLog — append-only audit of every signed-URL issuance decision.
-- 4) CHECKs: 'file' joins the allowed fixedContentType values (Offer and the
--    Product projection); the file form requires instant_fixed + fixedFileId
--    and forbids fixedContent (text/url semantics stay on fixedContent).

ALTER TABLE "Offer" ADD COLUMN "fixedFileId" INTEGER;
ALTER TABLE "Offer"
  ADD CONSTRAINT "Offer_fixedFileId_fkey"
    FOREIGN KEY ("fixedFileId") REFERENCES "DeliveryFile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Offer" DROP CONSTRAINT "Offer_fixedContentType_allowed_check";
ALTER TABLE "Offer"
  ADD CONSTRAINT "Offer_fixedContentType_allowed_check"
    CHECK ("fixedContentType" IN ('text', 'url', 'file')),
  ADD CONSTRAINT "Offer_fixed_file_form_check"
    CHECK (
      ("fixedContentType" = 'file'
        AND "deliveryMode" = 'instant_fixed'
        AND "fixedFileId" IS NOT NULL
        AND "fixedContent" IS NULL)
      OR ("fixedContentType" <> 'file' AND "fixedFileId" IS NULL)
    );

ALTER TABLE "Product" DROP CONSTRAINT "Product_fixedContentType_valid_check";
ALTER TABLE "Product"
  ADD CONSTRAINT "Product_fixedContentType_valid_check"
    CHECK ("fixedContentType" IN ('text', 'url', 'file'));

ALTER TABLE "DeliveryRecord" ADD COLUMN "fileId" INTEGER;
ALTER TABLE "DeliveryRecord"
  ADD CONSTRAINT "DeliveryRecord_fileId_fkey"
    FOREIGN KEY ("fileId") REFERENCES "DeliveryFile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "FileGrantLog" (
    "id" SERIAL NOT NULL,
    "fileId" INTEGER NOT NULL,
    "orderId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "role" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "ipHash" TEXT,
    "userAgent" TEXT,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FileGrantLog_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "FileGrantLog_role_allowed_check"
      CHECK ("role" IN ('buyer', 'merchant', 'admin')),
    CONSTRAINT "FileGrantLog_outcome_allowed_check"
      CHECK ("outcome" IN ('granted', 'denied_state', 'denied_window', 'denied_revoked'))
);

CREATE INDEX "FileGrantLog_fileId_createdAt_idx" ON "FileGrantLog"("fileId", "createdAt");
CREATE INDEX "FileGrantLog_orderId_idx" ON "FileGrantLog"("orderId");

ALTER TABLE "FileGrantLog"
  ADD CONSTRAINT "FileGrantLog_fileId_fkey"
    FOREIGN KEY ("fileId") REFERENCES "DeliveryFile"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "FileGrantLog_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "FileGrantLog_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
