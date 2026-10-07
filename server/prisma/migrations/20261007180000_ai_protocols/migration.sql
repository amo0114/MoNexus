ALTER TABLE "AiRuntimeConfig"
  ADD COLUMN "protocol" TEXT NOT NULL DEFAULT 'openai_responses',
  ADD COLUMN "outputMode" TEXT NOT NULL DEFAULT 'json_schema',
  ADD COLUMN "reasoningMode" TEXT NOT NULL DEFAULT 'none';
ALTER TABLE "AiRuntimeConfig"
  ADD CONSTRAINT "AiRuntimeConfig_protocol_check" CHECK ("protocol" IN ('openai_responses', 'openai_chat', 'anthropic_messages')),
  ADD CONSTRAINT "AiRuntimeConfig_outputMode_check" CHECK ("outputMode" IN ('json_schema', 'json_object')),
  ADD CONSTRAINT "AiRuntimeConfig_reasoningMode_check" CHECK ("reasoningMode" IN ('none', 'default'));
