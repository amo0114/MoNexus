CREATE TABLE "MailRuntimeConfig" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "version" INTEGER NOT NULL DEFAULT 0,
    "draft" JSONB,
    "draftCredentialsCiphertext" TEXT,
    "testedVersion" INTEGER,
    "active" JSONB,
    "activeCredentialsCiphertext" TEXT,
    "activeVersion" INTEGER NOT NULL DEFAULT 0,
    "previous" JSONB,
    "previousCredentialsCiphertext" TEXT,
    "rollbackAvailable" BOOLEAN NOT NULL DEFAULT false,
    "updatedBy" INTEGER,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MailRuntimeConfig_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "MailRuntimeConfig_singleton" CHECK ("id" = 1),
    CONSTRAINT "MailRuntimeConfig_version" CHECK ("version" >= 0 AND "activeVersion" >= 0)
);
