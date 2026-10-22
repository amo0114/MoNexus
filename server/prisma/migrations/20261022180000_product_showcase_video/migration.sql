CREATE TABLE "ProductVideoAsset" (
 "id" TEXT NOT NULL PRIMARY KEY, "merchantId" INTEGER, "createdById" INTEGER NOT NULL,
 "providerConfigId" INTEGER, "videoStoredObjectId" INTEGER, "posterStoredObjectId" INTEGER,
 "status" TEXT NOT NULL DEFAULT 'uploading', "durationMs" INTEGER NOT NULL DEFAULT 0,
 "width" INTEGER NOT NULL DEFAULT 0, "height" INTEGER NOT NULL DEFAULT 0,
 "hasAudio" BOOLEAN NOT NULL DEFAULT false,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "ProductVideoAsset_status_check" CHECK ("status" IN ('uploading','ready','failed','deleting')),
 CONSTRAINT "ProductVideoAsset_ready_check" CHECK ("status" <> 'ready' OR
  ("videoStoredObjectId" IS NOT NULL AND "posterStoredObjectId" IS NOT NULL AND "durationMs" > 0 AND "width" > 0 AND "height" > 0)),
 CONSTRAINT "ProductVideoAsset_videoStoredObjectId_fkey" FOREIGN KEY ("videoStoredObjectId") REFERENCES "StoredObject"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT "ProductVideoAsset_posterStoredObjectId_fkey" FOREIGN KEY ("posterStoredObjectId") REFERENCES "StoredObject"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ProductVideoAsset_videoStoredObjectId_key" ON "ProductVideoAsset"("videoStoredObjectId");
CREATE UNIQUE INDEX "ProductVideoAsset_posterStoredObjectId_key" ON "ProductVideoAsset"("posterStoredObjectId");
CREATE INDEX "ProductVideoAsset_merchantId_status_idx" ON "ProductVideoAsset"("merchantId", "status");
CREATE INDEX "ProductVideoAsset_status_updatedAt_idx" ON "ProductVideoAsset"("status", "updatedAt");
ALTER TABLE "Product" ADD COLUMN "promoVideoAssetId" TEXT;
CREATE UNIQUE INDEX "Product_promoVideoAssetId_key" ON "Product"("promoVideoAssetId");
ALTER TABLE "Product" ADD CONSTRAINT "Product_promoVideoAssetId_fkey" FOREIGN KEY ("promoVideoAssetId") REFERENCES "ProductVideoAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
