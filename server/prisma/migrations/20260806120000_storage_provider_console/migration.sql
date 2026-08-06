-- SPEC-STORAGE-001: object storage provider console
ALTER TABLE "DeliveryFile" ADD COLUMN "storageProviderId" INTEGER;

CREATE TABLE "StorageProviderConfig" (
    "id" SERIAL NOT NULL,
    "type" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "configVersion" INTEGER NOT NULL DEFAULT 1,
    "publicConfig" JSONB NOT NULL,
    "credentialsCiphertext" TEXT,
    "credentialsKeyVersion" INTEGER NOT NULL DEFAULT 1,
    "accessKeyLast4" TEXT,
    "lastTestAt" TIMESTAMP(3),
    "lastTestOk" BOOLEAN,
    "lastTestSummary" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "activatedAt" TIMESTAMP(3),
    "disabledAt" TIMESTAMP(3),
    "activatedById" INTEGER,
    "createdById" INTEGER,
    "previousActiveId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StorageProviderConfig_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "StorageRuntime" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "activeConfigId" INTEGER,
    "configVersion" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StorageRuntime_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "StoredObject" (
    "id" SERIAL NOT NULL,
    "providerConfigId" INTEGER,
    "providerRef" TEXT NOT NULL DEFAULT 'env',
    "bucketRole" TEXT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "size" INTEGER,
    "checksum" TEXT,
    "mimeType" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "source" TEXT,
    "sourceId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StoredObject_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "StorageProviderConfig_status_idx" ON "StorageProviderConfig"("status");
CREATE INDEX "StoredObject_objectKey_idx" ON "StoredObject"("objectKey");
CREATE INDEX "StoredObject_providerConfigId_idx" ON "StoredObject"("providerConfigId");
CREATE INDEX "StoredObject_source_sourceId_idx" ON "StoredObject"("source", "sourceId");
CREATE INDEX "DeliveryFile_storageProviderId_idx" ON "DeliveryFile"("storageProviderId");
CREATE UNIQUE INDEX "StoredObject_bucketRole_objectKey_providerRef_key" ON "StoredObject"("bucketRole", "objectKey", "providerRef");

ALTER TABLE "DeliveryFile" ADD CONSTRAINT "DeliveryFile_storageProviderId_fkey" FOREIGN KEY ("storageProviderId") REFERENCES "StorageProviderConfig"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "StoredObject" ADD CONSTRAINT "StoredObject_providerConfigId_fkey" FOREIGN KEY ("providerConfigId") REFERENCES "StorageProviderConfig"("id") ON DELETE SET NULL ON UPDATE CASCADE;

INSERT INTO "StorageRuntime" ("id", "activeConfigId", "configVersion", "updatedAt")
VALUES (1, NULL, 0, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;
