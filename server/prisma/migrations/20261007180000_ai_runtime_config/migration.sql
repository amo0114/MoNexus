CREATE TABLE "AiRuntimeConfig" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "version" INTEGER NOT NULL DEFAULT 1,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "productCopilotEnabled" BOOLEAN NOT NULL DEFAULT false,
    "apiKeyCiphertext" TEXT,
    "apiKeyLast4" TEXT,
    "updatedBy" INTEGER,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "AiRuntimeConfig_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AiRuntimeConfig_singleton" CHECK ("id" = 1 AND "version" > 0),
    CONSTRAINT "AiRuntimeConfig_flags" CHECK (NOT "productCopilotEnabled" OR "enabled"),
    CONSTRAINT "AiRuntimeConfig_key_required" CHECK (NOT "enabled" OR "apiKeyCiphertext" IS NOT NULL),
    CONSTRAINT "AiRuntimeConfig_key_pair" CHECK (("apiKeyCiphertext" IS NULL) = ("apiKeyLast4" IS NULL))
);
