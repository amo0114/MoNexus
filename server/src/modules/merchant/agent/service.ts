// SPEC-MERCHANT-AGENT-001 §8 / §9 — turn orchestration. Initial access and the
// selected resource are verified before a quota slot is taken; the same checks
// run again before every step and before the result is returned.

import { config } from '../../../config/index.js'
import { businessDateString, businessDayStartUtc } from '../../../lib/businessTime.js'
import { forbidden, notFound, sessionRevoked } from '../../../lib/httpError.js'
import { computeAiAgentRunInputHash, effectiveReasoningMode, getAiDailyQuota, isAiFeatureEnabled } from '../../../lib/ai/generation.js'
import { getAiRuntimeConfig } from '../../../lib/ai/runtimeConfig.js'
import { runAiTask } from '../../../lib/ai/task.js'
import { prisma } from '../../../lib/prisma.js'
import type { AuthPayload } from '../../../middlewares/auth.js'
import {
  AGENT_FEATURE,
  AGENT_LIMITS,
  AGENT_PROMPT_VERSION,
  AGENT_VALIDATOR_VERSION,
  BUDGET_VERSION,
  TOOL_CATALOG_VERSION,
} from './constants.js'
import { runAgentTurn, type TurnResult } from './runner.js'
import type { TurnRequest } from './schema.js'
import { AgentRunState } from './tools.js'

async function activeMerchantId(userId: number): Promise<number> {
  const merchant = await prisma.merchant.findUnique({ where: { userId }, select: { id: true, status: true } })
  if (!merchant || merchant.status !== 'active') throw forbidden('需要已激活商家权限')
  return merchant.id
}

/** Current user/merchant/session/switch state, not the request's original snapshot. */
async function assertStillAllowed(user: AuthPayload) {
  const [account, session] = await Promise.all([
    prisma.user.findUnique({ where: { id: user.userId }, select: { status: true } }),
    user.sid
      ? prisma.refreshToken.findFirst({ where: { userId: user.userId, sessionId: user.sid, revoked: false, expiresAt: { gt: new Date() } }, select: { id: true } })
      : Promise.resolve({ id: 0 }),
  ])
  if (!account || account.status === '已封禁') throw forbidden('账号不可用')
  if (!session) throw sessionRevoked()
  await activeMerchantId(user.userId)
  if (!await isAiFeatureEnabled(AGENT_FEATURE)) throw notFound()
}

export async function getAgentAvailability(user: AuthPayload) {
  await activeMerchantId(user.userId)
  const limits = { messageMax: AGENT_LIMITS.messageMax, sourceNotesMax: AGENT_LIMITS.sourceNotesMax, recentMessages: AGENT_LIMITS.recentMessages }
  if (!await isAiFeatureEnabled(AGENT_FEATURE)) return { available: false, reason: 'disabled' as const, limits }
  const quota = await getAiDailyQuota(AGENT_FEATURE, 'merchant')
  const used = await prisma.aiGeneration.count({
    where: { actorUserId: user.userId, feature: AGENT_FEATURE, createdAt: { gte: businessDayStartUtc(businessDateString(new Date())) } },
  })
  if (quota <= 0 || used >= quota) return { available: false, reason: 'quota' as const, limits }
  return { available: true, reason: 'ready' as const, limits }
}

/** Ownership check for the client's selection; foreign and missing look the same. */
async function selectedRef(state: AgentRunState, selected: TurnRequest['selectedResource']): Promise<string | null> {
  if (!selected) return null
  const owned = selected.type === 'product'
    ? await prisma.product.findFirst({ where: { id: selected.id, merchantId: state.merchantId, archivedAt: null }, select: { id: true } })
    : selected.type === 'order'
      ? await prisma.order.findFirst({ where: { id: selected.id, merchantId: state.merchantId }, select: { id: true } })
      : await prisma.offer.findFirst({ where: { id: selected.id, product: { merchantId: state.merchantId } }, select: { id: true } })
  if (!owned) throw notFound('所选对象不存在')
  if (selected.type === 'product') return state.ref({ kind: 'product', productId: selected.id })
  return state.ref({ kind: 'item', rule: selected.type === 'order' ? 'fulfillment_due' : 'low_availability', targetId: selected.id })
}

export async function runAgentTurnRequest(user: AuthPayload, body: TurnRequest, signal: AbortSignal): Promise<TurnResult & { generationId: number }> {
  if (!await isAiFeatureEnabled(AGENT_FEATURE)) throw notFound()
  const merchantId = await activeMerchantId(user.userId)
  const state = new AgentRunState(merchantId, user.userId)
  const selected = await selectedRef(state, body.selectedResource)
  const input = {
    message: body.message,
    recentUserMessages: body.recentUserMessages ?? [],
    publicSourceNotes: body.publicSourceNotes ?? null,
    selectedRef: selected,
  }

  const runtime = await getAiRuntimeConfig()
  // AI-R21a: whitelisted initial input only; no ids of the request, secrets or tool results.
  const inputHash = computeAiAgentRunInputHash({
    schemaVersion: 1,
    feature: AGENT_FEATURE,
    promptVersion: AGENT_PROMPT_VERSION,
    validatorVersion: AGENT_VALIDATOR_VERSION,
    toolCatalogVersion: TOOL_CATALOG_VERSION,
    budgetVersion: BUDGET_VERSION,
    config: { version: runtime.version, protocol: runtime.protocol, model: runtime.model, reasoningMode: effectiveReasoningMode(AGENT_FEATURE, runtime) },
    message: input.message,
    recentUserMessages: input.recentUserMessages,
    publicSourceNotes: input.publicSourceNotes,
    selectedResource: body.selectedResource ?? null,
  })

  const { generationId, value } = await runAiTask({
    feature: AGENT_FEATURE,
    actor: { userId: user.userId, role: 'merchant' },
    target: { type: 'merchant_agent', id: user.userId },
    promptVersion: AGENT_PROMPT_VERSION,
    validatorVersion: AGENT_VALIDATOR_VERSION,
    inputHash,
    deadlineMs: Math.min(config.ai.timeoutMs, AGENT_LIMITS.runMs),
    callTimeoutMs: AGENT_LIMITS.callMs,
    reserveMs: AGENT_LIMITS.reserveMs,
    signal,
    run: task => runAgentTurn(task, state, input, () => assertStillAllowed(user)),
  })
  return { ...value, generationId }
}
