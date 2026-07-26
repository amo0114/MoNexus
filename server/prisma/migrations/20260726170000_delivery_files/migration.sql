-- P5 T1: 受控文件交付的文件登记表。对象在私有交付桶，本表是引用真相源。
CREATE TABLE "DeliveryFile" (
    "id" SERIAL NOT NULL,
    "key" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "merchantId" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "DeliveryFile_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "DeliveryFile_merchantId_status_idx" ON "DeliveryFile"("merchantId", "status");
CREATE INDEX "DeliveryFile_key_idx" ON "DeliveryFile"("key");

ALTER TABLE "DeliveryFile" ADD CONSTRAINT "DeliveryFile_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
