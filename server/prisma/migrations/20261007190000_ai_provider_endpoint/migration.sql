ALTER TABLE "AiRuntimeConfig"
    ADD COLUMN "baseUrl" TEXT NOT NULL DEFAULT 'https://api.openai.com/v1',
    ADD COLUMN "model" TEXT NOT NULL DEFAULT 'gpt-6-luna';
