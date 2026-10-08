-- SPEC-MERCHANT-AGENT-001 A0 / SPEC-AI-001 1.3.0 — runtime flags and run
-- metadata for the merchant operations agent. Still metadata only: no column
-- may hold a prompt, model input, tool result or model output (AI-R20).

ALTER TABLE "AiRuntimeConfig"
  ADD COLUMN "merchantAgentEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "merchantAgentReasoningMode" TEXT NOT NULL DEFAULT 'default';
ALTER TABLE "AiRuntimeConfig" DROP CONSTRAINT "AiRuntimeConfig_flags";
ALTER TABLE "AiRuntimeConfig"
  ADD CONSTRAINT "AiRuntimeConfig_flags" CHECK ((NOT "productCopilotEnabled" OR "enabled") AND (NOT "merchantAgentEnabled" OR "enabled")),
  ADD CONSTRAINT "AiRuntimeConfig_merchantAgentReasoningMode_check" CHECK ("merchantAgentReasoningMode" IN ('none', 'default'));

-- One row per agent run (one daily quota slot), keyed by the actor so that a
-- second concurrent run of the same actor is rejected as in flight.
ALTER TABLE "AiGeneration"
  ADD COLUMN "stepCount" INTEGER,
  ADD COLUMN "toolCallCount" INTEGER,
  ADD COLUMN "stopReason" TEXT;
ALTER TABLE "AiGeneration" DROP CONSTRAINT "AiGeneration_feature_check";
ALTER TABLE "AiGeneration" DROP CONSTRAINT "AiGeneration_targetType_check";
ALTER TABLE "AiGeneration"
  ADD CONSTRAINT "AiGeneration_feature_check" CHECK ("feature" IN ('product_content_copilot', 'merchant_operations_agent')),
  ADD CONSTRAINT "AiGeneration_targetType_check" CHECK ("targetType" IN ('product', 'product_draft', 'merchant_agent')),
  ADD CONSTRAINT "AiGeneration_agent_target_check" CHECK (
    ("feature" = 'merchant_operations_agent') = ("targetType" = 'merchant_agent')
    AND ("feature" <> 'merchant_operations_agent' OR "actorRole" = 'merchant')
  ),
  -- Run counters exist only on agent rows. On those rows: no applied telemetry,
  -- at most the six content fields suggested, and issueCounts (when the content
  -- step ran) is exactly the four non-negative integer counters.
  ADD CONSTRAINT "AiGeneration_run_fields_check" CHECK (
    CASE WHEN "feature" = 'merchant_operations_agent' THEN
      ("stepCount" IS NULL OR "stepCount" >= 0)
      AND ("toolCallCount" IS NULL OR "toolCallCount" >= 0)
      AND ("stopReason" IS NULL OR "stopReason" ~ '^[a-z][a-z_]{0,39}$')
      AND "acceptedFieldCount" IS NULL
      AND ("suggestedFieldCount" IS NULL OR "suggestedFieldCount" <= 6)
      AND ("issueCounts" IS NULL OR (
        jsonb_typeof("issueCounts") = 'object'
        AND "issueCounts" ?& ARRAY['missing', 'ambiguous', 'risky_claim', 'unsupported_fact']
        AND "issueCounts" - ARRAY['missing', 'ambiguous', 'risky_claim', 'unsupported_fact'] = '{}'::jsonb
        AND jsonb_typeof("issueCounts" -> 'missing') = 'number' AND ("issueCounts" ->> 'missing') ~ '^[0-9]+$'
        AND jsonb_typeof("issueCounts" -> 'ambiguous') = 'number' AND ("issueCounts" ->> 'ambiguous') ~ '^[0-9]+$'
        AND jsonb_typeof("issueCounts" -> 'risky_claim') = 'number' AND ("issueCounts" ->> 'risky_claim') ~ '^[0-9]+$'
        AND jsonb_typeof("issueCounts" -> 'unsupported_fact') = 'number' AND ("issueCounts" ->> 'unsupported_fact') ~ '^[0-9]+$'
      ))
    ELSE "stepCount" IS NULL AND "toolCallCount" IS NULL AND "stopReason" IS NULL
    END
  );
