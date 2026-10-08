// SPEC-AI-001 1.3.0 §11 / SPEC-MERCHANT-AGENT-001 §4.1 — the controlled run
// container. One run = one AiGeneration row and one quota slot. Features never
// touch the provider directly: every model call goes through `task.generate`,
// which owns the shared deadline, cancellation and usage accounting.

import { Prisma } from '@prisma/client'
import { config } from '../../config/index.js'
import { businessDateString, businessDayStartUtc } from '../businessTime.js'
import { HttpError, notFound } from '../httpError.js'
import { logger } from '../logger.js'
import { prisma } from '../prisma.js'
import { aiGenerationDuration, aiGenerationTotal, aiTokensTotal } from './metrics.js'
import { getLlmProvider, LlmError } from './provider.js'
import type { AiSafe } from './safe.js'
import { getAiRuntimeConfig } from './runtimeConfig.js'
import {
  effectiveReasoningMode,
  getAiDailyQuota,
  isAiFeatureEnabled,
  type AiActorRole,
  type AiFeature,
  type IssueCounts,
} from './generation.js'

const AI_GENERATION_LOCK_CLASS = 20261007
const IN_FLIGHT_GRACE_MS = 5_000

export type AiTargetType = 'product' | 'product_draft' | 'merchant_agent'

export interface AiTaskGenerateRequest {
  schemaName: string
  system: string
  input: AiSafe<unknown>
  outputSchema: Record<string, unknown>
  maxOutputTokens: number
}

export interface AiTask {
  readonly generationId: number
  readonly signal: AbortSignal
  /** Milliseconds left before the run deadline. */
  remainingMs(): number
  generate(req: AiTaskGenerateRequest): Promise<unknown>
  countToolCall(): void
  setContentCounts(issueCounts: IssueCounts, suggestedFieldCount: number): void
}

export interface RunAiTaskArgs<T> {
  feature: AiFeature
  actor: { userId: number; role: AiActorRole }
  target: { type: AiTargetType; id: number }
  promptVersion: string
  validatorVersion: string
  inputHash: string
  /** Whole-run deadline shared by every model call and tool. */
  deadlineMs: number
  /** Cap for a single provider call; also keeps `reserveMs` free for finalisation. */
  callTimeoutMs?: number
  reserveMs?: number
  /** External cancellation, e.g. the HTTP client disconnected. */
  signal?: AbortSignal
  run: (task: AiTask) => Promise<{ value: T; stopReason?: string }>
}

/** The run ended because the caller went away; there is nobody to answer. */
export class AiTaskCancelledError extends Error {
  constructor() { super('ai task cancelled') }
}

/** No time is left for another model call. */
export class AiTaskBudgetError extends Error {
  constructor() { super('ai task budget exhausted') }
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

const STOP_FOR_FAILURE: Record<FailureCode, string> = {
  AI_TIMEOUT: 'timeout',
  AI_PROVIDER_ERROR: 'provider_error',
  AI_OUTPUT_INVALID: 'output_invalid',
}

async function claimSlot(args: Pick<RunAiTaskArgs<unknown>, 'feature' | 'actor' | 'target' | 'promptVersion' | 'validatorVersion' | 'inputHash'>,
  providerName: string, model: string) {
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
        model,
        promptVersion: args.promptVersion,
        validatorVersion: args.validatorVersion,
        inputHash: args.inputHash,
        status: 'pending',
      },
      select: { id: true },
    })
  })
}

export async function runAiTask<T>(args: RunAiTaskArgs<T>): Promise<{ generationId: number; value: T }> {
  // One configuration snapshot per run; later saves apply to the next run.
  const runtime = await getAiRuntimeConfig()
  if (!await isAiFeatureEnabled(args.feature, runtime)) throw notFound()
  if (args.signal?.aborted) throw new AiTaskCancelledError()

  const provider = await getLlmProvider({ ...runtime, reasoningMode: effectiveReasoningMode(args.feature, runtime) })
  const row = await claimSlot(args, provider.name, runtime.model)

  const isRun = args.feature === 'merchant_operations_agent'
  const controller = new AbortController()
  const startedAt = Date.now()
  const deadline = startedAt + args.deadlineMs
  const deadlineTimer = setTimeout(() => controller.abort('timeout'), args.deadlineMs)
  const onExternalAbort = () => controller.abort('client_disconnected')
  args.signal?.addEventListener('abort', onExternalAbort, { once: true })

  let steps = 0
  let toolCalls = 0
  // Unknown usage in any step makes the total unknown, never zero.
  let inputTokens: number | null = 0
  let outputTokens: number | null = 0
  let reportedModel = runtime.model
  let contentCounts: { issueCounts: IssueCounts; suggestedFieldCount: number } | null = null

  const remainingMs = () => deadline - Date.now()
  const task: AiTask = {
    generationId: row.id,
    signal: controller.signal,
    remainingMs,
    countToolCall: () => { toolCalls += 1 },
    setContentCounts: (issueCounts, suggestedFieldCount) => { contentCounts = { issueCounts, suggestedFieldCount } },
    async generate(req) {
      if (controller.signal.aborted) throw controller.signal.reason === 'client_disconnected' ? new AiTaskCancelledError() : new LlmError('timeout')
      const callBudget = Math.min(args.callTimeoutMs ?? Infinity, remainingMs() - (args.reserveMs ?? 0))
      if (callBudget <= 0) throw new AiTaskBudgetError()
      steps += 1
      const call = new AbortController()
      const callTimer = setTimeout(() => call.abort(), callBudget)
      const onRunAbort = () => call.abort()
      controller.signal.addEventListener('abort', onRunAbort, { once: true })
      try {
        const result = await provider.generateStructured({
          model: runtime.model,
          reasoningEffort: 'none',
          schemaName: req.schemaName,
          system: req.system,
          input: req.input,
          outputSchema: req.outputSchema,
          maxOutputTokens: req.maxOutputTokens,
          signal: call.signal,
        })
        inputTokens = inputTokens == null || result.usage.inputTokens == null ? null : inputTokens + result.usage.inputTokens
        outputTokens = outputTokens == null || result.usage.outputTokens == null ? null : outputTokens + result.usage.outputTokens
        reportedModel = result.model || runtime.model
        if (controller.signal.reason === 'client_disconnected') throw new AiTaskCancelledError()
        return result.output
      } catch (err) {
        // A call that did not return has unknown usage.
        inputTokens = null
        outputTokens = null
        if (controller.signal.reason === 'client_disconnected') throw new AiTaskCancelledError()
        // An abort we triggered is a timeout regardless of how the SDK surfaced it.
        if (call.signal.aborted) throw new LlmError('timeout')
        throw err
      } finally {
        clearTimeout(callTimer)
        controller.signal.removeEventListener('abort', onRunAbort)
      }
    },
  }

  const finish = async (data: { status: 'succeeded' | 'failed'; errorCode: FailureCode | null; stopReason: string | null }) => {
    const latencyMs = Date.now() - startedAt
    const counts = contentCounts as { issueCounts: IssueCounts; suggestedFieldCount: number } | null
    await prisma.aiGeneration.update({
      where: { id: row.id },
      data: {
        status: data.status,
        errorCode: data.errorCode,
        model: reportedModel,
        inputTokens: steps === 0 ? null : inputTokens,
        outputTokens: steps === 0 ? null : outputTokens,
        latencyMs,
        ...(counts ? { issueCounts: counts.issueCounts as unknown as Prisma.InputJsonValue, suggestedFieldCount: counts.suggestedFieldCount } : {}),
        ...(isRun ? { stepCount: steps, toolCallCount: toolCalls, stopReason: data.stopReason } : {}),
        completedAt: new Date(),
      },
    })
    aiGenerationTotal.inc({ feature: args.feature, status: data.status, error_code: data.errorCode ?? 'none' })
    aiGenerationDuration.observe({ feature: args.feature }, latencyMs / 1000)
    if (steps > 0 && inputTokens != null) aiTokensTotal.inc({ feature: args.feature, direction: 'input' }, inputTokens)
    if (steps > 0 && outputTokens != null) aiTokensTotal.inc({ feature: args.feature, direction: 'output' }, outputTokens)
    return latencyMs
  }

  try {
    const result = await args.run(task)
    if (controller.signal.reason === 'client_disconnected') throw new AiTaskCancelledError()
    await finish({ status: 'succeeded', errorCode: null, stopReason: result.stopReason ?? null })
    return { generationId: row.id, value: result.value }
  } catch (err) {
    if (err instanceof AiTaskCancelledError) {
      await finish({ status: 'failed', errorCode: null, stopReason: 'client_disconnected' })
      throw err
    }
    // Run features surface their own access errors (revoked merchant, disabled flag) unchanged.
    if (isRun && err instanceof HttpError) {
      await finish({ status: 'failed', errorCode: null, stopReason: 'access_revoked' })
      throw err
    }
    const failure = failureFor(err)
    const latencyMs = await finish({ status: 'failed', errorCode: failure.code, stopReason: STOP_FOR_FAILURE[failure.code] })
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
    clearTimeout(deadlineTimer)
    args.signal?.removeEventListener('abort', onExternalAbort)
  }
}
