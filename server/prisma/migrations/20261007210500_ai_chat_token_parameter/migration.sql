ALTER TABLE "AiRuntimeConfig"
  ADD COLUMN "chatTokenParameter" TEXT NOT NULL DEFAULT 'max_tokens',
  ADD CONSTRAINT "AiRuntimeConfig_chatTokenParameter_check" CHECK ("chatTokenParameter" IN ('max_tokens', 'max_completion_tokens'));
