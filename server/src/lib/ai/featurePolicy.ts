import type { Prisma } from '@prisma/client'
import { forbidden } from '../httpError.js'
import { getSystemConfigValue, type SystemConfigKey } from '../systemConfig.js'
import type { AiReasoningMode } from './protocol.js'
import { aiMerchantAgentEnabled, aiProductCopilotEnabled, getAiRuntimeConfig, type AiRuntimeSettings } from './runtimeConfig.js'

export const AI_FEATURES = ['product_content_copilot', 'merchant_operations_agent'] as const
export type AiFeature = (typeof AI_FEATURES)[number]
export type AiActorRole = 'merchant' | 'admin'

export type IssueCounts = {
  missing: number
  ambiguous: number
  risky_claim: number
  unsupported_fact: number
}

// Each feature lists only the roles it supports; a missing role has no quota key at all.
const QUOTA_KEYS: Record<AiFeature, Partial<Record<AiActorRole, SystemConfigKey>>> = {
  product_content_copilot: {
    admin: 'aiProductCopilotDailyQuotaAdmin',
    merchant: 'aiProductCopilotDailyQuotaMerchant',
  },
  merchant_operations_agent: {
    merchant: 'aiMerchantAgentDailyQuotaMerchant',
  },
}

export function aiFeatureSupportsRole(feature: AiFeature, role: AiActorRole): boolean {
  return QUOTA_KEYS[feature][role] !== undefined
}

export async function isAiFeatureEnabled(feature: AiFeature, settings?: AiRuntimeSettings): Promise<boolean> {
  const runtime = settings ?? await getAiRuntimeConfig()
  switch (feature) {
    case 'product_content_copilot':
      return aiProductCopilotEnabled(runtime)
    case 'merchant_operations_agent':
      return aiMerchantAgentEnabled(runtime)
  }
}

/** The reasoning mode a call of this feature runs with (SPEC-AI-001 1.3.0 §6.2). */
export function effectiveReasoningMode(feature: AiFeature, settings: AiRuntimeSettings): AiReasoningMode {
  return feature === 'merchant_operations_agent' ? settings.merchantAgentReasoningMode : settings.reasoningMode
}

export async function getAiDailyQuota(
  feature: AiFeature,
  role: AiActorRole,
  tx?: Prisma.TransactionClient,
): Promise<number> {
  const key = QUOTA_KEYS[feature][role]
  // Rejected before any quota row is read: an unsupported role never gets a fake quota.
  if (!key) throw forbidden('当前账号角色不能使用该 AI 功能')
  return getSystemConfigValue(key, tx)
}
