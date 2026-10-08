import type { AiRuntimeConfig, Prisma } from '@prisma/client'
import { config } from '../../config/index.js'
import { prisma } from '../prisma.js'
import { decryptAiApiKey } from './credentialsCrypto.js'
import type { AiProtocol, AiOutputMode, AiReasoningMode, AiChatTokenParameter } from './protocol.js'
import { DEFAULT_AI_BASE_URL, DEFAULT_AI_MODEL } from './endpoint.js'

export function resolveAiRuntimeConfig(row: AiRuntimeConfig | null) {
  let apiKey = row ? null : config.ai.openaiApiKey ?? null
  let credentialError = false
  if (row?.apiKeyCiphertext) {
    try {
      apiKey = decryptAiApiKey(row.apiKeyCiphertext)
    } catch {
      // Fail closed for AI while keeping the manual product editor usable.
      credentialError = true
    }
  }
  return {
    version: row?.version ?? 0,
    source: row ? 'database' as const : 'environment' as const,
    enabled: row?.enabled ?? config.ai.enabled,
    productCopilotEnabled: row?.productCopilotEnabled ?? config.ai.productCopilotEnabled,
    // No env bootstrap: the agent can only be switched on from admin settings.
    merchantAgentEnabled: row?.merchantAgentEnabled ?? false,
    merchantAgentReasoningMode: (row?.merchantAgentReasoningMode ?? 'default') as AiReasoningMode,
    baseUrl: row?.baseUrl ?? DEFAULT_AI_BASE_URL,
    chatTokenParameter: (row?.chatTokenParameter ?? 'max_tokens') as AiChatTokenParameter,
    protocol: (row?.protocol ?? 'openai_responses') as AiProtocol,
    outputMode: (row?.outputMode ?? 'json_schema') as AiOutputMode,
    reasoningMode: (row?.reasoningMode ?? 'none') as AiReasoningMode,
    model: row?.model ?? DEFAULT_AI_MODEL,
    apiKey,
    apiKeyConfigured: row ? Boolean(row.apiKeyCiphertext) : Boolean(apiKey),
    apiKeyLast4: row ? row.apiKeyLast4 : apiKey?.slice(-4) ?? null,
    credentialError,
  }
}

/** No process cache: saves and key rotation apply to the next request on every process. */
export async function getAiRuntimeConfig(tx?: Prisma.TransactionClient) {
  const row = await (tx ?? prisma).aiRuntimeConfig.findUnique({ where: { id: 1 } })
  return resolveAiRuntimeConfig(row)
}

export type AiRuntimeSettings = Awaited<ReturnType<typeof getAiRuntimeConfig>>

export function aiProductCopilotEnabled(settings: AiRuntimeSettings): boolean {
  return settings.enabled && settings.productCopilotEnabled && Boolean(settings.apiKey) && !settings.credentialError
}

/** The agent reads workbench facts, so it also needs MERCHANT_WORKBENCH_ENABLED (env, restart to change). */
export function aiMerchantAgentEnabled(settings: AiRuntimeSettings): boolean {
  return settings.enabled && settings.merchantAgentEnabled && Boolean(settings.apiKey) && !settings.credentialError
    && config.merchantWorkbenchEnabled
}
