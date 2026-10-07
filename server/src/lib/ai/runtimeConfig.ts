import type { AiRuntimeConfig, Prisma } from '@prisma/client'
import { config } from '../../config/index.js'
import { prisma } from '../prisma.js'
import { decryptAiApiKey } from './credentialsCrypto.js'
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
    baseUrl: row?.baseUrl ?? DEFAULT_AI_BASE_URL,
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
