// SPEC-AI-001 §9–§11 — the only entry point that calls an LLM provider.
// It owns flags, per-actor daily quota, in-flight dedupe, the timeout, the
// AiGeneration metadata row and metrics. Prompts, inputs and outputs are never
// persisted or logged (AI-R20).

import { createHmac } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { config } from '../../config/index.js'
import { businessDateString, businessDayStartUtc } from '../businessTime.js'
import { HttpError, notFound } from '../httpError.js'
import { logger } from '../logger.js'
import { prisma } from '../prisma.js'
import { getSystemConfigValue, type SystemConfigKey } from '../systemConfig.js'
import { aiGenerationDuration, aiGenerationTotal, aiTokensTotal } from './metrics.js'
import { getLlmProvider, LlmError } from './provider.js'
import type { AiSafe } from './safe.js'

export const AI_FEATURES = ['product_content_copilot'] as const
export type AiFeature = (typeof AI_FEATURES)[number]
export type AiActorRole = 'merchant' | 'admin'

export type IssueCounts = {
  missing: number
  ambiguous: number
  risky_claim: number
  unsupported_fact: number
}

const AI_GENERATION_LOCK_CLASS = 20261007
const IN_FLIGHT_GRACE_MS = 5_000
const INPUT_HASH_DOMAIN = 'monexus:ai-input-hash:v1\0'

const QUOTA_KEYS: Record<AiFeature, Record<AiActorRole, SystemConfigKey>> = {
  product_content_copilot: {
    admin: 'aiProductCopilotDailyQuotaAdmin',
    merchant: 'aiProductCopilotDailyQuotaMerchant',
  },
}

export function isAiFeatureEnabled(feature: AiFeature): boolean {
  if (!config.ai.enabled) return false
  switch (feature) {
    case 'product_content_copilot':
      return config.ai.productCopilotEnabled
  }
}

export async function getAiDailyQuota(
  feature: AiFeature,
  role: AiActorRole,
  tx?: Prisma.TransactionClient,
): Promise<number> {
  return getSystemConfigValue(QUOTA_KEYS[feature][role], tx)
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** AI-R21: domain-separated HMAC so this message space never overlaps other jwtSecret HMACs. */
export function computeAiInputHash(input: unknown): string {
  return createHmac('sha256', config.jwtSecret)
    .update(INPUT_HASH_DOMAIN + canonicalJson(input))
    .digest('hex')
}

export interface RunAiGenerationArgs<T> {
  feature: AiFeature
  actor: { userId: number; role: AiActorRole }
  target: { type: 'product'; id: number }
  promptVersion: string
  validatorVersion: string
  model: string
  reasoningEffort: 'none'
  schemaName: string
  system: string
  input: AiSafe<unknown>
  outputSchema: Record<string, unknown>
  maxOutputTokens: number
  parse: (raw: unknown) => { value: T; issueCounts: IssueCounts; suggestedFieldCount: number }
}

type FailureCode = 'AI_TIMEOUT' | 'AI_PROVIDER_ERROR' | 'AI_OUTPUT_INVALID'

function failureFor(err: unknown): { code: FailureCode; httpError: HttpError } {
  if (err instanceof LlmError) {
    if (err.code === 'timeout') {
      return { code: 'AI_TIMEOUT', httpError: new HttpError(504, 'AI_TIMEOUT', 'AI 整理超时，请稍后重试或继续手动编辑') }
    }
    if (err.code === 'output_unparseable') {
      return { code: 'AI_OUTPUT_INVALID', httpError: new HttpError(502, 'AI_OUTPUT_INVALID', 'AI 返回的内容无法使用，请稍后重试') }
    }
    return { code: 'AI_PROVIDER_ERROR', httpError: new HttpError(502, 'AI_PROVIDER_ERROR', 'AI 服务暂时不可用，请稍后重试或继续手动编辑') }
  }
  return { code: 'AI_OUTPUT_INVALID', httpError: new HttpError(502, 'AI_OUTPUT_INVALID', 'AI 返回的内容无法使用，请稍后重试') }
}

async function claimGenerationSlot<T>(args: RunAiGenerationArgs<T>, inputHash: string, providerName: string) {
  const now = new Date()
  const dayStart = businessDayStartUtc(businessDateString(now))
  const inFlightSince = new Date(now.getTime() - config.ai.timeoutMs - IN_FLIGHT_GRACE_MS)

  return prisma.$transaction(async tx => {
    // Serialises quota checks per actor; the provider call happens outside.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${AI_GENERATION_LOCK_CLASS}::int4, ${args.actor.userId}::int4)`

    const quota = await getAiDailyQuota(args.feature, args.actor.role, tx)
    const used = await tx.aiGeneration.count({
      where: { actorUserId: args.actor.userId, feature: args.feature, createdAt: { gte: dayStart } },
    })
    if (quota <= 0 || used >= quota) {
      throw new HttpError(429, 'AI_QUOTA_EXCEEDED', '今日 AI 整理次数已用完，明天再试')
    }

    const inFlight = await tx.aiGeneration.count({
      where: {
        actorUserId: args.actor.userId,
        feature: args.feature,
        targetType: args.target.type,
        targetId: args.target.id,
        status: 'pending',
        createdAt: { gt: inFlightSince },
      },
    })
    if (inFlight > 0) {
      throw new HttpError(409, 'AI_GENERATION_IN_PROGRESS', '上一次整理仍在进行中，请稍后')
    }

    return tx.aiGeneration.create({
      data: {
        feature: args.feature,
        actorUserId: args.actor.userId,
        actorRole: args.actor.role,
        targetType: args.target.type,
        targetId: args.target.id,
        provider: providerName,
        model: args.model,
        promptVersion: args.promptVersion,
        validatorVersion: args.validatorVersion,
        inputHash,
        status: 'pending',
      },
      select: { id: true },
    })
  })
}

export async function runAiGeneration<T>(args: RunAiGenerationArgs<T>): Promise<{ generationId: number; value: T }> {
  if (!isAiFeatureEnabled(args.feature)) throw notFound()

  const provider = await getLlmProvider()
  const inputHash = computeAiInputHash(args.input)
  const row = await claimGenerationSlot(args, inputHash, provider.name)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.ai.timeoutMs)
  const startedAt = Date.now()
  let usage: { inputTokens: number | null; outputTokens: number | null } = { inputTokens: null, outputTokens: null }
  let reportedModel = args.model

  try {
    let result
    try {
      result = await provider.generateStructured({
        model: args.model,
        reasoningEffort: args.reasoningEffort,
        schemaName: args.schemaName,
        system: args.system,
        input: args.input,
        outputSchema: args.outputSchema,
        maxOutputTokens: args.maxOutputTokens,
        signal: controller.signal,
      })
    } catch (err) {
      // An abort we triggered is a timeout regardless of how the SDK surfaced it.
      throw controller.signal.aborted ? new LlmError('timeout') : err
    }
    usage = result.usage
    reportedModel = result.model || args.model
    const parsed = args.parse(result.output)
    const latencyMs = Date.now() - startedAt

    await prisma.aiGeneration.update({
      where: { id: row.id },
      data: {
        status: 'succeeded',
        model: reportedModel,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        latencyMs,
        issueCounts: parsed.issueCounts as unknown as Prisma.InputJsonValue,
        suggestedFieldCount: parsed.suggestedFieldCount,
        completedAt: new Date(),
      },
    })
    recordMetrics(args.feature, 'succeeded', 'none', latencyMs, usage)
    return { generationId: row.id, value: parsed.value }
  } catch (err) {
    const failure = failureFor(err)
    const latencyMs = Date.now() - startedAt
    await prisma.aiGeneration.update({
      where: { id: row.id },
      data: {
        status: 'failed',
        errorCode: failure.code,
        model: reportedModel,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        latencyMs,
        completedAt: new Date(),
      },
    })
    recordMetrics(args.feature, 'failed', failure.code, latencyMs, usage)
    logger.warn(
      {
        generationId: row.id,
        feature: args.feature,
        errorCode: failure.code,
        llmErrorCode: err instanceof LlmError ? err.code : 'parse',
        latencyMs,
      },
      'ai generation failed',
    )
    throw failure.httpError
  } finally {
    clearTimeout(timer)
  }
}

function recordMetrics(
  feature: AiFeature,
  status: 'succeeded' | 'failed',
  errorCode: string,
  latencyMs: number,
  usage: { inputTokens: number | null; outputTokens: number | null },
) {
  aiGenerationTotal.inc({ feature, status, error_code: errorCode })
  aiGenerationDuration.observe({ feature }, latencyMs / 1000)
  if (usage.inputTokens != null) aiTokensTotal.inc({ feature, direction: 'input' }, usage.inputTokens)
  if (usage.outputTokens != null) aiTokensTotal.inc({ feature, direction: 'output' }, usage.outputTokens)
}

/**
 * Best-effort client telemetry (SPEC-AI-PRODUCT-001 §9.2 / CP-12): only
 * product metrics, never used for permissions, state or publishing.
 */
export async function recordAiGenerationApplied(args: {
  feature: AiFeature
  generationId: number
  actorUserId: number
  target: { type: 'product'; id: number }
  appliedFieldCount: number
}): Promise<void> {
  if (!isAiFeatureEnabled(args.feature)) throw notFound()
  const row = await prisma.aiGeneration.findFirst({
    where: {
      id: args.generationId,
      feature: args.feature,
      actorUserId: args.actorUserId,
      targetType: args.target.type,
      targetId: args.target.id,
      status: 'succeeded',
    },
    select: { id: true, suggestedFieldCount: true },
  })
  if (!row) throw notFound()
  if (args.appliedFieldCount > (row.suggestedFieldCount ?? 0)) {
    throw new HttpError(400, 'BAD_REQUEST', '采纳字段数超出本次建议数')
  }
  await prisma.aiGeneration.update({
    where: { id: row.id },
    data: { acceptedFieldCount: args.appliedFieldCount },
  })
}
