// SPEC-MERCHANT-AGENT-001 A1 — run container, model-chosen tool loop, refs,
// budgets, proposal and cancellation. The provider is always a test double.

import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from '../app.js'
import { config } from '../config/index.js'
import { encryptAiApiKey } from '../lib/ai/credentialsCrypto.js'
import { setLlmProviderForTests, type LlmProvider, type LlmStructuredRequest } from '../lib/ai/provider.js'
import { prisma } from '../lib/prisma.js'
import { EMPTY_PRODUCT_DETAILS } from '../modules/catalog/templates/types.js'
import { api, authHeader, createTestMerchant, createTestProduct, getDefaultOfferId, loginAs } from './helpers.js'
import { getActiveCategoryIdByLabel } from './catalogFixture.js'

type Script = (req: LlmStructuredRequest, step: number) => Promise<unknown> | unknown
const calls: LlmStructuredRequest[] = []
let script: Script = () => { throw new Error('no script') }
const provider: LlmProvider = {
  name: 'test-double',
  async generateStructured(req) {
    calls.push(req)
    return { output: await script(req, calls.length - 1), usage: { inputTokens: 100, outputTokens: 20 }, model: 'test-model' }
  },
}

const savedAi = { ...config.ai }
const savedWorkbench = config.merchantWorkbenchEnabled
const empty = { tool: null, answer: null, clarify: null, prepareContent: null }
const tool = (fields: Record<string, unknown>) => ({ ...empty, kind: 'tool', tool: {
  name: null, group: null, cursorRef: null, query: null, status: null, productRef: null, itemRef: null, targetFields: null, topic: null, ...fields,
} })
const answer = (blocks: Array<{ text: string; evidenceRefs: string[]; actionRef: string | null }>) => ({ ...empty, kind: 'answer', answer: { blocks } })
const observations = (req: LlmStructuredRequest) => (req.input as unknown as { observations: Array<{ tool: string; status: string; data?: any }> }).observations

async function enableAgent(quota = 5) {
  config.ai.credentialsEncKey = 'ab'.repeat(32)
  await prisma.aiRuntimeConfig.create({ data: {
    id: 1, version: 1, enabled: true, merchantAgentEnabled: true,
    apiKeyCiphertext: encryptAiApiKey('sk-test-AGENT_KEY_1234567890'), apiKeyLast4: '7890',
  } })
  await prisma.systemConfig.upsert({ where: { key: 'aiMerchantAgentDailyQuotaMerchant' }, create: { key: 'aiMerchantAgentDailyQuotaMerchant', value: quota }, update: { value: quota } })
}

async function merchant(email = 'agent-merchant@test.local') {
  const { merchant } = await createTestMerchant(email, 'pass123', { status: 'active' })
  const { accessToken } = await loginAs(email, 'pass123')
  return { merchantId: merchant.id, token: accessToken }
}

const turn = (token: string, body: Record<string, unknown>) =>
  api.post('/api/merchant/agent/turns').set(authHeader(token)).send({ requestId: 'r1', ...body })

beforeEach(async () => {
  calls.length = 0
  setLlmProviderForTests(provider)
  config.merchantWorkbenchEnabled = true
  await enableAgent()
})
afterEach(() => {
  setLlmProviderForTests(null)
  Object.assign(config.ai, savedAi)
  config.merchantWorkbenchEnabled = savedWorkbench
  vi.restoreAllMocks()
})

describe('merchant agent turns', () => {
  it('lets the model pick a tool from the question, then answers with server-resolved evidence and action', async () => {
    const { merchantId, token } = await merchant()
    const product = await createTestProduct('售罄的商品', 100, 0, [], merchantId)
    const offerId = await getDefaultOfferId(product.id)
    script = (req, step) => {
      if (step === 0) return tool({ name: 'read_workbench', group: 'urgent' })
      const soldOut = observations(req)[0].data.soldOut.candidates[0]
      return answer([{ text: '先补充售罄规格的库存。', evidenceRefs: [soldOut.ref], actionRef: soldOut.actionRef }])
    }
    const res = await turn(token, { message: '今天先看订单和售罄，草稿稍后再说' }).expect(200)

    expect(res.body).toMatchObject({ outcome: 'answered', stopReason: 'answer', steps: [{ tool: 'read_workbench', status: 'ok' }] })
    expect(res.body.blocks[0].action).toEqual({ kind: 'manage_availability', productId: product.id, offerId })
    expect(res.body.evidence.find((card: any) => card.ref === res.body.blocks[0].evidenceRefs[0]).item.targetId).toBe(offerId)
    expect(calls).toHaveLength(2)
    expect(observations(calls[0])).toEqual([])
    // The model sees refs and bands, not ids or exact quantities.
    const seen = JSON.stringify(calls[1].input)
    expect(seen).toContain('sold_out')
    expect(seen).not.toContain(`"targetId"`)
    expect(seen).not.toContain('"available"')

    const row = await prisma.aiGeneration.findUniqueOrThrow({ where: { id: res.body.generationId } })
    expect(row).toMatchObject({ feature: 'merchant_operations_agent', targetType: 'merchant_agent', status: 'succeeded',
      stepCount: 2, toolCallCount: 1, stopReason: 'answer', inputTokens: 200, outputTokens: 40, issueCounts: null })
    expect(row.provider).toBe('test-double')
    expect(await prisma.inventoryLog.count()).toBe(0)
  })

  it('rejects a fabricated reference instead of returning it', async () => {
    const { token } = await merchant()
    script = () => answer([{ text: '去补货。', evidenceRefs: ['P99'], actionRef: null }])
    await turn(token, { message: '怎么办' }).expect(502)
    const row = await prisma.aiGeneration.findFirstOrThrow({ where: { feature: 'merchant_operations_agent' } })
    expect(row).toMatchObject({ status: 'failed', errorCode: 'AI_OUTPUT_INVALID', stopReason: 'output_invalid' })
  })

  it('stops with a limited result when the tool budget is used up or the model repeats itself', async () => {
    const { token } = await merchant()
    const tools = [tool({ name: 'read_help', topic: 'publication' }), tool({ name: 'read_help', topic: 'availability' }),
      tool({ name: 'read_help', topic: 'manual_fulfillment' }), tool({ name: 'read_help', topic: 'content_boundaries' })]
    script = (_req, step) => tools[step]
    const limited = await turn(token, { message: '介绍一下规则' }).expect(200)
    expect(limited.body).toMatchObject({ outcome: 'limited', stopReason: 'budget', blocks: [] })
    expect(await prisma.aiGeneration.findUniqueOrThrow({ where: { id: limited.body.generationId } }))
      .toMatchObject({ status: 'succeeded', stepCount: 4, toolCallCount: 3 })

    await prisma.aiGeneration.deleteMany()
    script = () => tool({ name: 'read_help', topic: 'publication' })
    expect((await turn(token, { message: '再说一次' }).expect(200)).body).toMatchObject({ outcome: 'limited', stopReason: 'no_progress' })
  })

  it('refuses foreign selections, a disabled agent and exhausted quota before calling the model', async () => {
    const { token } = await merchant()
    const other = await createTestMerchant('agent-other@test.local', 'pass123', { status: 'active' })
    const foreign = await createTestProduct('别家商品', 100, 0, [], other.merchant.id)
    await turn(token, { message: '看看它', selectedResource: { type: 'product', id: foreign.id } }).expect(404)
    await prisma.systemConfig.update({ where: { key: 'aiMerchantAgentDailyQuotaMerchant' }, data: { value: 0 } })
    await turn(token, { message: '看看' }).expect(429)
    expect((await api.get('/api/merchant/agent/availability').set(authHeader(token)).expect(200)).body).toMatchObject({ available: false, reason: 'quota' })
    await prisma.aiRuntimeConfig.update({ where: { id: 1 }, data: { merchantAgentEnabled: false } })
    await turn(token, { message: '看看' }).expect(404)
    expect((await api.get('/api/merchant/agent/availability').set(authHeader(token)).expect(200)).body).toMatchObject({ available: false, reason: 'disabled' })
    expect(calls).toHaveLength(0)
    expect(await prisma.aiGeneration.count()).toBe(0)
  })

  it('reads the selected product content, then prepares a reviewable proposal without writing it', async () => {
    const { token } = await merchant('agent-copy@test.local')
    const categoryId = await getActiveCategoryIdByLabel('充值卡密')
    const created = await api.post('/api/merchant/products').set(authHeader(token)).send({
      editorVersion: 2, templateKey: 'fixed_content', templateVersion: 1, name: '学习指引', categoryId,
      description: '旧简介', richDescription: null, descriptionImages: [], images: [], visibility: 'members_only',
      attributes: { contentCategory: '学习指引', applicableScope: '入门学习' }, details: EMPTY_PRODUCT_DETAILS, purchaseForm: [],
      offers: [{ name: '完整版', price: 100, originalPrice: null, attributes: { contentScope: '完整文字指引' }, deliveryMode: 'instant_fixed',
        stockMode: 'unlimited', validityDays: null, fixedContentType: 'text', fixedContent: 'SECRET_FIXED_4711', fixedFileId: null,
        fixedStructuredContent: null, deliveryFields: null, autoProvision: false }],
    }).expect(201)
    const productId = created.body.id as number
    script = (req, step) => {
      const selectedRef = (req.input as unknown as { request?: { selectedRef: string } }).request?.selectedRef
      if (step === 0) return tool({ name: 'read_product_content', productRef: selectedRef, targetFields: ['description', 'purchaseNotes'] })
      if (step === 1) return { ...empty, kind: 'prepare_content', prepareContent: { productRef: selectedRef, fields: ['description'] } }
      return { description: { text: '下单后自动交付的学习指引。', claims: [{ kind: 'delivery_method', span: '下单后自动交付', factRef: 'common.deliveryMethod' }] },
        highlights: null, usageInstructions: null, purchaseNotes: null, afterSalesInstructions: null, faq: null, issues: [] }
    }
    const res = await turn(token, { message: '帮我完善这个商品的简介', selectedResource: { type: 'product', id: productId } }).expect(200)

    expect(res.body).toMatchObject({ outcome: 'proposal', stopReason: 'proposal' })
    expect(res.body.proposal).toMatchObject({ productId, basedOnContentVersion: 1, promptVersion: 'product-content@1' })
    expect(res.body.proposal.fields.description).toEqual({ status: 'suggested', value: '下单后自动交付的学习指引。', rejectedItemCount: 0 })
    expect(observations(calls[1])[0].data).toMatchObject({ emptyFields: expect.arrayContaining(['purchaseNotes']) })
    // The copy step only receives this product's AI-safe context, never planning history or secrets.
    expect(calls[2].schemaName).toBe('product_content_suggestion')
    expect(JSON.stringify(calls[2].input)).not.toContain('observations')
    expect(JSON.stringify(calls.map(call => call.input))).not.toContain('SECRET_FIXED_4711')
    expect(await prisma.aiGeneration.findUniqueOrThrow({ where: { id: res.body.generationId } }))
      .toMatchObject({ stepCount: 3, toolCallCount: 1, suggestedFieldCount: 1, stopReason: 'proposal' })
    expect((await prisma.product.findUniqueOrThrow({ where: { id: productId } })).contentVersion).toBe(1)
  })

  it('cancels the run when the HTTP client disconnects mid-call', async () => {
    const { token } = await merchant('agent-cancel@test.local')
    let aborted = false
    let entered!: () => void
    const providerEntered = new Promise<void>(resolve => { entered = resolve })
    script = req => new Promise((_resolve, reject) => {
      entered()
      req.signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')) })
    })
    const server = app.listen(0)
    try {
      const { port } = server.address() as AddressInfo
      const client = new AbortController()
      const pending = fetch(`http://127.0.0.1:${port}/api/merchant/agent/turns`, {
        method: 'POST', signal: client.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ requestId: 'r-cancel', message: '今天先处理什么' }),
      }).catch(() => null)
      await providerEntered
      client.abort()
      await pending
      await vi.waitFor(async () => expect(await prisma.aiGeneration.findFirst({ where: { status: 'failed' } })).toMatchObject({
        stopReason: 'client_disconnected', stepCount: 1, toolCallCount: 0,
      }))
      expect(aborted).toBe(true)
      expect(calls).toHaveLength(1)
    } finally {
      server.close()
    }
  })
})
