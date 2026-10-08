-- SPEC-MERCHANT-AGENT-001 pilot: who may use the operations agent. Default
-- audience is the pilot list, and nobody is on it until an admin adds them.
ALTER TABLE "Merchant" ADD COLUMN "agentPilot" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "AiRuntimeConfig" ADD COLUMN "merchantAgentAudience" TEXT NOT NULL DEFAULT 'pilot';
ALTER TABLE "AiRuntimeConfig"
  ADD CONSTRAINT "AiRuntimeConfig_merchantAgentAudience_check" CHECK ("merchantAgentAudience" IN ('pilot', 'all'));
