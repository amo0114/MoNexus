-- Draft suggestions have no Product row. The target id is the authenticated
-- actor id, used only for in-flight deduplication under the shared Copilot quota.
ALTER TABLE "AiGeneration" DROP CONSTRAINT "AiGeneration_targetType_check";
ALTER TABLE "AiGeneration" ADD CONSTRAINT "AiGeneration_targetType_check"
  CHECK ("targetType" IN ('product', 'product_draft'));
