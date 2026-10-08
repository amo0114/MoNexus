// SPEC-MERCHANT-AGENT-001 A0 / SPEC-AI-001 1.3.0 — shared AI runtime pieces the
// merchant operations agent needs: feature/role quota mapping, flags, effective
// reasoning mode, admin settings, run metadata constraints and the run input HMAC.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Prisma } from '@prisma/client'
import { config } from '../config/index.js'
import { prisma } from '../lib/prisma.js'
import { api, authHeader, createTestUser, loginAs } from './helpers.js'
import { getAiRuntimeConfig } from '../lib/ai/runtimeConfig.js'
import {
  aiFeatureSupportsRole,
  computeAiAgentRunInputHash,
  computeAiInputHash,
  effectiveReasoningMode,
  getAiDailyQuota,
  isAiFeatureEnabled,
  runAiGeneration,
} from '../lib/ai/generation.js'
import * as providerModule from '../lib/ai/provider.js'
import { markAiSafe } from '../lib/ai/safe.js'

const KEY = 'sk-test-AGENT_SENTINEL_1234567890'
const originalAi = { ...config.ai }
const originalWorkbench = config.merchantWorkbenchEnabled
let token: string
let adminId: number

beforeEach(async () => {
  Object.assign(config.ai, { enabled: false, productCopilotEnabled: false, openaiApiKey: undefined, credentialsEncKey: 'ab'.repeat(32) })
  config.merchantWorkbenchEnabled = true
  const { user, password } = await createTestUser('agent-ai-admin@test.local', 'pass123', 'admin')
  adminId = user.id
  token = (await loginAs(user.email, password)).accessToken
})
afterEach(() => {
  Object.assign(config.ai, originalAi)
  config.merchantWorkbenchEnabled = originalWorkbench
  providerModule.setLlmProviderForTests(null)
  vi.restoreAllMocks()
})

function save(body: Record<string, unknown>) {
  return api.put('/api/admin/ai/config').set(authHeader(token)).send({ expectedVersion: 0, enabled: false, productCopilotEnabled: false, ...body })
}

describe('admin settings for the merchant agent', () => {
  it('defaults the agent off with its own default reasoning mode and exposes the workbench dependency read-only', async () => {
    const body = (await api.get('/api/admin/ai/config').set(authHeader(token)).expect(200)).body
    expect(body).toMatchObject({ merchantAgentEnabled: false, merchantAgentReasoningMode: 'default', merchantAgentAudience: 'pilot', merchantWorkbenchEnabled: true, reasoningMode: 'none' })
    config.merchantWorkbenchEnabled = false
    expect((await api.get('/api/admin/ai/config').set(authHeader(token))).body.merchantWorkbenchEnabled).toBe(false)
  })

  it('saves the agent switch and mode independently of the global reasoning mode and audits only flags', async () => {
    const saved = await save({ apiKey: KEY, enabled: true, merchantAgentEnabled: true, merchantAgentReasoningMode: 'none', merchantAgentAudience: 'all', reasoningMode: 'default' }).expect(200)
    expect(saved.body).toMatchObject({ enabled: true, productCopilotEnabled: false, merchantAgentEnabled: true, merchantAgentReasoningMode: 'none', merchantAgentAudience: 'all', reasoningMode: 'default' })
    const log = await prisma.adminLog.findFirstOrThrow({ where: { adminUserId: adminId, action: '更新 AI 配置' }, orderBy: { id: 'desc' } })
    expect(JSON.parse(log.detail!)).toMatchObject({ merchantAgentEnabled: true, merchantAgentReasoningMode: 'none' })
    expect(log.detail).not.toContain(KEY)

    // Omitted agent fields are preserved for older clients.
    await save({ expectedVersion: 1, enabled: true }).expect(200)
    expect(await getAiRuntimeConfig()).toMatchObject({ merchantAgentEnabled: true, merchantAgentReasoningMode: 'none' })
  })

  it('rejects the agent without AI, switches it off with AI and with a cleared key', async () => {
    await save({ apiKey: KEY, merchantAgentEnabled: true }).expect(400)
    await save({ apiKey: KEY, enabled: true, merchantAgentEnabled: true }).expect(200)
    await save({ expectedVersion: 1, enabled: false }).expect(200)
    expect((await getAiRuntimeConfig()).merchantAgentEnabled).toBe(false)

    await save({ expectedVersion: 2, enabled: true, merchantAgentEnabled: true }).expect(200)
    await save({ expectedVersion: 3, enabled: true, merchantAgentEnabled: true, apiKey: null }).expect(200)
    expect(await getAiRuntimeConfig()).toMatchObject({ enabled: false, merchantAgentEnabled: false, apiKeyConfigured: false })
    await save({ expectedVersion: 4, merchantAgentReasoningMode: 'high' }).expect(400)
  })
})

describe('agent feature flag, quota roles and reasoning mode', () => {
  it('is enabled only with AI, the agent switch, a usable key and the workbench env flag', async () => {
    const runtime = await getAiRuntimeConfig()
    const on = { ...runtime, enabled: true, merchantAgentEnabled: true, apiKey: KEY, credentialError: false }
    expect(await isAiFeatureEnabled('merchant_operations_agent', on)).toBe(true)
    expect(await isAiFeatureEnabled('product_content_copilot', on)).toBe(false)
    expect(await isAiFeatureEnabled('merchant_operations_agent', { ...on, enabled: false })).toBe(false)
    expect(await isAiFeatureEnabled('merchant_operations_agent', { ...on, merchantAgentEnabled: false })).toBe(false)
    expect(await isAiFeatureEnabled('merchant_operations_agent', { ...on, apiKey: null })).toBe(false)
    expect(await isAiFeatureEnabled('merchant_operations_agent', { ...on, credentialError: true })).toBe(false)
    config.merchantWorkbenchEnabled = false
    expect(await isAiFeatureEnabled('merchant_operations_agent', on)).toBe(false)
  })

  it('maps quotas per supported role and refuses an unsupported role before reading any quota', async () => {
    expect(aiFeatureSupportsRole('merchant_operations_agent', 'merchant')).toBe(true)
    expect(aiFeatureSupportsRole('merchant_operations_agent', 'admin')).toBe(false)
    expect(aiFeatureSupportsRole('product_content_copilot', 'admin')).toBe(true)
    expect(await getAiDailyQuota('merchant_operations_agent', 'merchant')).toBe(0)
    await api.put('/api/admin/config/aiMerchantAgentDailyQuotaMerchant').set(authHeader(token)).send({ value: 4 }).expect(200)
    await api.put('/api/admin/config/aiMerchantAgentDailyQuotaMerchant').set(authHeader(token)).send({ value: 1001 }).expect(400)
    expect(await getAiDailyQuota('merchant_operations_agent', 'merchant')).toBe(4)
    expect(await getAiDailyQuota('product_content_copilot', 'merchant')).toBe(0)
    await expect(getAiDailyQuota('merchant_operations_agent', 'admin')).rejects.toMatchObject({ status: 403 })
  })

  it('uses the global mode for the copilot and the agent mode for the agent', async () => {
    const runtime = { ...(await getAiRuntimeConfig()), reasoningMode: 'none' as const, merchantAgentReasoningMode: 'default' as const }
    expect(effectiveReasoningMode('product_content_copilot', runtime)).toBe('none')
    expect(effectiveReasoningMode('merchant_operations_agent', runtime)).toBe('default')
  })

  it('builds the copilot provider with the global mode even when the agent mode differs', async () => {
    await save({ apiKey: KEY, enabled: true, productCopilotEnabled: true, reasoningMode: 'none', merchantAgentReasoningMode: 'default' }).expect(200)
    await api.put('/api/admin/config/aiProductCopilotDailyQuotaAdmin').set(authHeader(token)).send({ value: 2 }).expect(200)
    const generateStructured = vi.fn().mockResolvedValue({ output: { ok: true }, usage: { inputTokens: 1, outputTokens: 1 }, model: 'm' })
    const getProvider = vi.spyOn(providerModule, 'getLlmProvider').mockResolvedValue({ name: 'stub', generateStructured })
    await runAiGeneration({
      feature: 'product_content_copilot', actor: { userId: adminId, role: 'admin' }, target: { type: 'product', id: 1 },
      promptVersion: 'test', validatorVersion: 'test', reasoningEffort: 'none', schemaName: 'test', system: 'fixed',
      input: markAiSafe({ x: 1 }), outputSchema: { type: 'object' }, maxOutputTokens: 10,
      parse: () => ({ value: true, issueCounts: { missing: 0, ambiguous: 0, risky_claim: 0, unsupported_fact: 0 }, suggestedFieldCount: 0 }),
    })
    expect(getProvider).toHaveBeenCalledWith(expect.objectContaining({ reasoningMode: 'none' }))
  })
})

describe('agent run metadata', () => {
  const counts = { missing: 0, ambiguous: 1, risky_claim: 0, unsupported_fact: 2 }
  function agentRow(data: Partial<Prisma.AiGenerationUncheckedCreateInput> = {}) {
    return prisma.aiGeneration.create({ data: {
      feature: 'merchant_operations_agent', actorUserId: adminId, actorRole: 'merchant', targetType: 'merchant_agent', targetId: adminId,
      provider: 'stub', model: 'm', promptVersion: 'p', validatorVersion: 'v', inputHash: 'a'.repeat(64), status: 'succeeded',
      stepCount: 3, toolCallCount: 2, stopReason: 'answered', suggestedFieldCount: 6, issueCounts: counts, ...data,
    } })
  }

  it('accepts a well-formed agent run row', async () => {
    await expect(agentRow()).resolves.toMatchObject({ stepCount: 3, toolCallCount: 2, stopReason: 'answered' })
    await expect(agentRow({ stepCount: null, toolCallCount: null, stopReason: null, suggestedFieldCount: null, issueCounts: Prisma.DbNull })).resolves.toBeTruthy()
  })

  it.each([
    ['product target', { targetType: 'product' }],
    ['admin actor', { actorRole: 'admin' }],
    ['applied telemetry', { acceptedFieldCount: 1, suggestedFieldCount: 6 }],
    ['more than six suggested fields', { suggestedFieldCount: 7 }],
    ['negative step count', { stepCount: -1 }],
    ['free-form stop reason', { stopReason: 'Stopped: model said hi' }],
    ['extra issue key', { issueCounts: { ...counts, note: 0 } }],
    ['missing issue key', { issueCounts: { missing: 0, ambiguous: 0, risky_claim: 0 } }],
    ['negative issue count', { issueCounts: { ...counts, missing: -1 } }],
    ['fractional issue count', { issueCounts: { ...counts, missing: 1.5 } }],
    ['string issue count', { issueCounts: { ...counts, missing: '1' } }],
  ] as const)('rejects an agent row with %s', async (_label, data) => {
    await expect(agentRow(data as Partial<Prisma.AiGenerationUncheckedCreateInput>)).rejects.toThrow()
  })

  it('keeps run counters off non-agent rows and the agent target off the copilot', async () => {
    const base = { feature: 'product_content_copilot', actorUserId: adminId, actorRole: 'admin', targetType: 'product', targetId: 1,
      provider: 'stub', model: 'm', promptVersion: 'p', validatorVersion: 'v', inputHash: 'b'.repeat(64) }
    await expect(prisma.aiGeneration.create({ data: { ...base, stepCount: 1 } })).rejects.toThrow()
    await expect(prisma.aiGeneration.create({ data: { ...base, stopReason: 'answered' } })).rejects.toThrow()
    await expect(prisma.aiGeneration.create({ data: { ...base, targetType: 'merchant_agent' } })).rejects.toThrow()
    await expect(prisma.aiGeneration.create({ data: base })).resolves.toBeTruthy()
  })

  it('keeps the runtime config agent switch behind the global switch at the database level', async () => {
    await save({ apiKey: KEY }).expect(200)
    await expect(prisma.aiRuntimeConfig.update({ where: { id: 1 }, data: { merchantAgentEnabled: true } })).rejects.toThrow()
    await expect(prisma.aiRuntimeConfig.update({ where: { id: 1 }, data: { merchantAgentReasoningMode: 'high' } })).rejects.toThrow()
  })

  it('fingerprints the run input in its own HMAC domain', () => {
    const input = { message: '今天先处理什么', selectedResource: null, recentUserMessages: [] }
    const hash = computeAiAgentRunInputHash(input)
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(computeAiAgentRunInputHash({ recentUserMessages: [], selectedResource: null, message: '今天先处理什么' })).toBe(hash)
    expect(hash).not.toBe(computeAiInputHash(input))
    expect(computeAiAgentRunInputHash({ ...input, message: '其他问题' })).not.toBe(hash)
  })
})
