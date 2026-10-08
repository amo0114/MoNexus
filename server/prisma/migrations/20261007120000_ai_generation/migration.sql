-- SPEC-AI-001 §10 — AI call metadata only. No column may ever hold a prompt,
-- model input or model output (AI-R20).
CREATE TABLE "AiGeneration" (
    "id" SERIAL NOT NULL,
    "feature" TEXT NOT NULL,
    "actorUserId" INTEGER,
    "actorRole" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" INTEGER NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "validatorVersion" TEXT NOT NULL,
    "inputHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "errorCode" TEXT,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "latencyMs" INTEGER,
    "issueCounts" JSONB,
    "suggestedFieldCount" INTEGER,
    "acceptedFieldCount" INTEGER,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMPTZ(3),

    CONSTRAINT "AiGeneration_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AiGeneration_feature_check" CHECK ("feature" IN ('product_content_copilot')),
    CONSTRAINT "AiGeneration_actorRole_check" CHECK ("actorRole" IN ('merchant', 'admin')),
    CONSTRAINT "AiGeneration_targetType_check" CHECK ("targetType" IN ('product')),
    CONSTRAINT "AiGeneration_status_check" CHECK ("status" IN ('pending', 'succeeded', 'failed')),
    CONSTRAINT "AiGeneration_errorCode_check" CHECK (
        "errorCode" IS NULL OR "errorCode" IN ('AI_TIMEOUT', 'AI_PROVIDER_ERROR', 'AI_OUTPUT_INVALID')
    ),
    CONSTRAINT "AiGeneration_inputHash_check" CHECK ("inputHash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "AiGeneration_counts_check" CHECK (
        ("inputTokens" IS NULL OR "inputTokens" >= 0)
        AND ("outputTokens" IS NULL OR "outputTokens" >= 0)
        AND ("latencyMs" IS NULL OR "latencyMs" >= 0)
        AND ("suggestedFieldCount" IS NULL OR "suggestedFieldCount" >= 0)
        AND ("acceptedFieldCount" IS NULL OR ("acceptedFieldCount" >= 1 AND "acceptedFieldCount" <= "suggestedFieldCount"))
    )
);

CREATE INDEX "AiGeneration_actorUserId_feature_createdAt_idx" ON "AiGeneration"("actorUserId", "feature", "createdAt");
CREATE INDEX "AiGeneration_feature_createdAt_idx" ON "AiGeneration"("feature", "createdAt");

ALTER TABLE "AiGeneration" ADD CONSTRAINT "AiGeneration_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
