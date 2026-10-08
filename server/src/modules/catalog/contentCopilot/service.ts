// SPEC-AI-PRODUCT-001 — content copilot orchestration. Reads go through the
// same ownership rule as patchProductContent; nothing here writes Product or
// Offer rows. Suggestions only return to the caller (CP-03).

import { HttpError, notFound, type ErrorCode } from '../../../lib/httpError.js'
import {
  getAiDailyQuota,
  isAiFeatureEnabled,
  recordAiGenerationApplied,
  runAiGeneration,
  type AiActorRole,
} from '../../../lib/ai/generation.js'
import { aiValidationRejectionsTotal } from '../../../lib/ai/metrics.js'
import { prisma } from '../../../lib/prisma.js'
import { CATALOG_ERROR_CODES } from '../constants.js'
import { checkProductReadiness } from '../publicationReadiness.js'
import { getProductTemplate } from '../templates/registry.js'
import type { TemplateKey } from '../templates/types.js'
import {
  CONTENT_COPILOT_FEATURE,
  CONTENT_FIELDS,
  MODEL_BINDING,
  PROMPT_VERSION,
  VALIDATOR_VERSION,
} from './constants.js'
import { MODEL_OUTPUT_SCHEMA } from './outputSchema.js'
import { buildProductContentAiContext, ContentContextTooLargeError } from './projection.js'
import { SYSTEM_PROMPT } from './prompt.js'
import type { ContentSuggestionRequest } from './schema.js'
import {
  countIssues,
  suggestedFieldCount,
  validateModelOutput,
  type ValidatedSuggestion,
} from './validator.js'

export type ContentCopilotActor =
  | { kind: 'merchant'; merchantId: number; userId: number }
  | { kind: 'admin'; userId: number }

function actorRole(actor: ContentCopilotActor): AiActorRole {
  return actor.kind
}

function ownershipWhere(actor: ContentCopilotActor, productId: number) {
  return actor.kind === 'merchant' ? { id: productId, merchantId: actor.merchantId } : { id: productId }
}

/** `getProductEditor` capability (§8.1): flags, templated, not archived, role quota > 0. */
export async function isContentCopilotAvailable(
  actorKind: 'merchant' | 'admin',
  product: { templateKey: string | null; templateVersion: number | null; archivedAt: Date | null },
): Promise<boolean> {
  if (!await isAiFeatureEnabled(CONTENT_COPILOT_FEATURE)) return false
  if (product.templateKey == null || product.templateVersion == null || product.archivedAt != null) return false
  return (await getAiDailyQuota(CONTENT_COPILOT_FEATURE, actorKind)) > 0
}

export async function generateContentSuggestion(
  actor: ContentCopilotActor,
  productId: number,
  input: ContentSuggestionRequest,
) {
  if (!await isAiFeatureEnabled(CONTENT_COPILOT_FEATURE)) throw notFound()
  const { context, readinessCodes, contentVersion, useUpstreamDescription } = await prepareContentSuggestionContext(actor, productId, input)

  const { generationId, value } = await runAiGeneration<ValidatedSuggestion>({
    feature: CONTENT_COPILOT_FEATURE,
    actor: { userId: actor.userId, role: actorRole(actor) },
    target: { type: 'product', id: productId },
    promptVersion: PROMPT_VERSION,
    validatorVersion: VALIDATOR_VERSION,
    reasoningEffort: MODEL_BINDING.reasoningEffort,
    schemaName: MODEL_BINDING.schemaName,
    system: SYSTEM_PROMPT,
    input: context,
    outputSchema: MODEL_OUTPUT_SCHEMA,
    maxOutputTokens: MODEL_BINDING.maxOutputTokens,
    parse: raw => {
      const validated = validateModelOutput({
        raw,
        context,
        readinessCodes,
        upstreamRequested: useUpstreamDescription,
        onReject: kind => aiValidationRejectionsTotal.inc({ feature: CONTENT_COPILOT_FEATURE, kind }),
      })
      return {
        value: validated,
        issueCounts: countIssues(validated.issues),
        suggestedFieldCount: suggestedFieldCount(validated.fields),
      }
    },
  })

  return {
    generationId,
    basedOnContentVersion: contentVersion,
    promptVersion: PROMPT_VERSION,
    validatorVersion: VALIDATOR_VERSION,
    fields: value.fields,
    issues: value.issues,
  }
}

/**
 * Ownership-checked read and AI-safe context for one product (§5). Shared by
 * the copilot endpoint and the merchant agent's read_product_content tool;
 * no feature flag or quota here — each caller gates its own feature.
 */
export async function prepareContentSuggestionContext(
  actor: ContentCopilotActor,
  productId: number,
  input: Partial<Pick<ContentSuggestionRequest, 'expectedContentVersion' | 'targetFields' | 'sourceNotes' | 'useUpstreamDescription'>>,
) {
  const product = await prisma.product.findFirst({
    where: ownershipWhere(actor, productId),
    select: {
      id: true,
      name: true,
      description: true,
      attributes: true,
      details: true,
      purchaseForm: true,
      templateKey: true,
      templateVersion: true,
      contentVersion: true,
      archivedAt: true,
      category: { select: { label: true } },
      offers: {
        where: { status: 'active' },
        orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          name: true,
          deliveryMode: true,
          autoProvision: true,
          externalIntegration: true,
          validityDays: true,
          deliveryFields: true,
          attributes: true,
        },
      },
    },
  })
  if (!product) throw notFound('商品不存在')
  if (product.archivedAt) {
    throw new HttpError(409, CATALOG_ERROR_CODES.PRODUCT_ARCHIVED as ErrorCode, '商品已归档，请先恢复后再使用')
  }
  const template = product.templateKey != null && product.templateVersion != null
    ? getProductTemplate(product.templateKey as TemplateKey, product.templateVersion)
    : null
  if (!template) {
    throw new HttpError(409, 'AI_PRODUCT_TEMPLATE_REQUIRED', '请先为商品选择商品形态后再使用 AI 整理')
  }

  // Xboard sources exist only on admin-imported platform products (§1-7); the
  // merchant path never reads ExternalCatalogLink.
  const link = actor.kind === 'admin'
    ? await prisma.externalCatalogLink.findUnique({
        where: { productId },
        select: { sourceSnapshot: true, latestDescriptionText: true },
      })
    : null
  const useUpstreamDescription = actor.kind === 'admin' && input.useUpstreamDescription === true
  if (useUpstreamDescription && !link) {
    throw new HttpError(400, 'BAD_REQUEST', '该商品不是 Xboard 导入商品，不能参考上游介绍')
  }
  if (input.expectedContentVersion !== undefined && product.contentVersion !== input.expectedContentVersion) {
    throw new HttpError(409, CATALOG_ERROR_CODES.PRODUCT_CONTENT_CHANGED as ErrorCode, '商品内容已更新，请刷新后再试')
  }

  // externalSku is read only to derive xboardPeriod and never enters the context.
  const skuByOffer = link
    ? new Map((await prisma.offer.findMany({
        where: { id: { in: product.offers.map(offer => offer.id) } },
        select: { id: true, externalSku: true },
      })).map(row => [row.id, row.externalSku]))
    : null

  const readiness = await checkProductReadiness(productId)
  const readinessCodes = readiness.details.map(detail => detail.code)
  const targetFields = input.targetFields ?? [...CONTENT_FIELDS]

  const context = buildContext({
    actorKind: actor.kind,
    template,
    categoryLabel: product.category.label,
    product: {
      name: product.name,
      description: product.description,
      attributes: product.attributes,
      details: product.details,
      purchaseForm: product.purchaseForm,
    },
    offers: product.offers.map(offer => ({ ...offer, externalSku: skuByOffer?.get(offer.id) ?? null })),
    externalLink: link,
    useUpstreamDescription,
    targetFields,
    sourceNotes: input.sourceNotes ?? null,
  })

  return { context, readinessCodes, contentVersion: product.contentVersion, useUpstreamDescription }
}

// Refused before any provider call or quota use (SPEC-AI-PRODUCT-001 §5.4).
function buildContext(input: Parameters<typeof buildProductContentAiContext>[0]) {
  try {
    return buildProductContentAiContext(input)
  } catch (err) {
    if (err instanceof ContentContextTooLargeError) {
      throw new HttpError(422, 'AI_CONTEXT_TOO_LARGE', '商品规格与参数信息过多，暂不支持 AI 整理，请手动编辑')
    }
    throw err
  }
}

export async function recordContentSuggestionApplied(
  actor: ContentCopilotActor,
  productId: number,
  generationId: number,
  appliedFieldCount: number,
): Promise<void> {
  await recordAiGenerationApplied({
    feature: CONTENT_COPILOT_FEATURE,
    generationId,
    actorUserId: actor.userId,
    target: { type: 'product', id: productId },
    appliedFieldCount,
  })
}
