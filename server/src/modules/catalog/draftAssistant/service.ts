import { getAiDailyQuota, isAiFeatureEnabled, runAiGeneration, type AiActorRole } from '../../../lib/ai/generation.js'
import { notFound } from '../../../lib/httpError.js'
import { getPublicCategoryRegistry } from '../registry.js'
import { getProductTemplateRegistry } from '../templates/registry.js'
import { buildProductDraftAiContext } from './projection.js'
import { DRAFT_MAX_OUTPUT_TOKENS, DRAFT_PROMPT_VERSION, DRAFT_SYSTEM_PROMPT, DRAFT_VALIDATOR_VERSION } from './prompt.js'
import { DRAFT_MODEL_SCHEMA } from './schema.js'
import { validateDraftSuggestion } from './validator.js'

const FEATURE = 'product_content_copilot' as const

export async function isDraftAssistantAvailable(role: AiActorRole) {
  return await isAiFeatureEnabled(FEATURE) && (await getAiDailyQuota(FEATURE, role)) > 0
}

export async function generateDraftSuggestion(actor: { userId: number; role: AiActorRole }, description: string) {
  if (!await isAiFeatureEnabled(FEATURE)) throw notFound()
  const categories = await getPublicCategoryRegistry()
  const context = buildProductDraftAiContext({
    description,
    templates: getProductTemplateRegistry().templates,
    categories: categories.productCategories,
  })
  const { generationId, value } = await runAiGeneration({
    feature: FEATURE,
    actor,
    target: { type: 'product_draft', id: actor.userId },
    promptVersion: DRAFT_PROMPT_VERSION,
    validatorVersion: DRAFT_VALIDATOR_VERSION,
    reasoningEffort: 'none',
    schemaName: 'product_draft_suggestion',
    system: DRAFT_SYSTEM_PROMPT,
    input: context,
    outputSchema: DRAFT_MODEL_SCHEMA,
    maxOutputTokens: DRAFT_MAX_OUTPUT_TOKENS,
    parse: raw => {
      const result = validateDraftSuggestion(raw, context)
      return {
        value: result,
        issueCounts: { missing: result.missingFields.length, unsupported_fact: result.rejectedFieldCount, risky_claim: 0, ambiguous: 0 },
        suggestedFieldCount: [result.suggestion.name, result.suggestion.description, result.suggestion.offerName,
          result.suggestion.templateKey, result.suggestion.categoryId, result.suggestion.details.usageInstructions,
          result.suggestion.details.purchaseNotes, result.suggestion.details.afterSalesInstructions]
          .filter(Boolean).length + result.suggestion.details.highlights.length
          + Object.keys(result.suggestion.attributes).length + Object.keys(result.suggestion.offerAttributes).length,
      }
    },
  })
  return { generationId, ...value }
}
