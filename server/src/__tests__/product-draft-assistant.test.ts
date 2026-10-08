import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { config } from '../config/index.js'
import { prisma } from '../lib/prisma.js'
import { LlmError, setLlmProviderForTests, type LlmStructuredRequest } from '../lib/ai/provider.js'
import { api, authHeader, createTestMerchant, createTestUser, loginAs } from './helpers.js'
import { getActiveCategoryIdByLabel } from './catalogFixture.js'
import { DRAFT_SAMPLE_DESCRIPTION, sampleDraftOutput } from '../modules/catalog/draftAssistant/fixtures.js'

const saved = { ...config.ai }
const calls: LlmStructuredRequest[] = []
let behaviour: (request: LlmStructuredRequest) => Promise<unknown>
async function actor(role: 'admin' | 'merchant' | 'user' = 'merchant') {
  const email = `${role}@draft.test.local`
  if (role === 'merchant') await createTestMerchant(email, 'pass123', { role, status: 'active' })
  else await createTestUser(email, 'pass123', role)
  return (await loginAs(email, 'pass123')).accessToken
}
function suggest(token: string, role = 'merchant', body: Record<string, unknown> = { description: DRAFT_SAMPLE_DESCRIPTION }) {
  return api.post(`/api/${role}/products/draft-suggestions`).set(authHeader(token)).send(body)
}
beforeEach(async () => {
  calls.length = 0
  config.ai.enabled = true
  config.ai.productCopilotEnabled = true
  config.ai.openaiApiKey = 'sk-draft-test-only'
  for (const key of ['aiProductCopilotDailyQuotaAdmin', 'aiProductCopilotDailyQuotaMerchant']) {
    await prisma.systemConfig.upsert({ where: { key }, create: { key, value: 5 }, update: { value: 5 } })
  }
  behaviour = async () => sampleDraftOutput(await getActiveCategoryIdByLabel('充值卡密'))
  setLlmProviderForTests({ name: 'draft-test', generateStructured: async request => {
    calls.push(request)
    return { output: await behaviour(request), usage: { inputTokens: 100, outputTokens: 50 }, model: 'test-model' }
  } })
})
afterEach(() => { Object.assign(config.ai, saved); setLlmProviderForTests(null) })

describe('AI draft assistant routes', () => {
  it.each(['merchant', 'admin'] as const)('returns suggestions for %s without creating products or persisting content', async role => {
    const token = await actor(role)
    const res = await suggest(token, role).expect(200)
    expect(res.body.suggestion.name).toBe('网络入门学习指南')
    expect(res.body.suggestion.introduction).toContain('商品介绍\n')
    expect(JSON.stringify(res.body)).not.toContain('sourceQuotes')
    expect(res.headers['cache-control']).toBe('no-store')
    expect(await prisma.product.count()).toBe(0)
    expect(await prisma.offer.count()).toBe(0)
    const row = await prisma.aiGeneration.findUniqueOrThrow({ where: { id: res.body.generationId } })
    expect(row).toMatchObject({ feature: 'product_content_copilot', targetType: 'product_draft', status: 'succeeded', actorRole: role,
      promptVersion: 'product-draft@2', validatorVersion: 'product-draft-validator@2' })
    expect(row.targetId).toBe(row.actorUserId)
    expect(JSON.stringify(row)).not.toContain('网络入门')
    expect(JSON.stringify(calls[0].input)).not.toContain('draft.test.local')
    expect(calls[0]).toMatchObject({ schemaName: 'product_draft_suggestion', reasoningEffort: 'none' })
  })

  it('requires authentication and the appropriate role before calling the provider', async () => {
    await api.post('/api/merchant/products/draft-suggestions').send({ description: '指南' }).expect(401)
    const token = await actor('user')
    await suggest(token).expect(403)
    await suggest(token, 'admin').expect(403)
    await api.get('/api/admin/products/draft-assistant').set(authHeader(token)).expect(403)
    expect(calls).toHaveLength(0)
    expect(await prisma.aiGeneration.count()).toBe(0)
  })

  it('enforces current administrator MFA and active merchant status', async () => {
    const adminToken = await actor('admin')
    await prisma.user.updateMany({ where: { role: 'admin' }, data: { mfaVersion: { increment: 1 } } })
    await suggest(adminToken, 'admin').expect(403)
    const token = await actor('merchant')
    await prisma.merchant.updateMany({ data: { status: 'suspended' } })
    await suggest(token).expect(403)
    expect(calls).toHaveLength(0)
  })

  it('hides the entry when disabled and rejects bad bodies before quota use', async () => {
    const token = await actor()
    await suggest(token, 'merchant', { description: '指南', productId: 6, fixedContent: 'PRIVATE' }).expect(400)
    await suggest(token, 'merchant', { description: 'x'.repeat(4001) }).expect(400)
    config.ai.productCopilotEnabled = false
    expect((await api.get('/api/merchant/products/draft-assistant').set(authHeader(token)).expect(200)).body.available).toBe(false)
    await suggest(token).expect(404)
    expect(calls).toHaveLength(0)
    expect(await prisma.aiGeneration.count()).toBe(0)
  })

  it('shares the content copilot quota and counts failures', async () => {
    const token = await actor()
    await prisma.systemConfig.update({ where: { key: 'aiProductCopilotDailyQuotaMerchant' }, data: { value: 1 } })
    behaviour = async () => { throw new LlmError('unavailable') }
    await suggest(token).expect(502)
    const quota = await suggest(token).expect(429)
    expect(quota.body.error.code).toBe('AI_QUOTA_EXCEEDED')
    expect(calls).toHaveLength(1)
    expect(await prisma.aiGeneration.count()).toBe(1)
  })

  it('deduplicates concurrent new-draft requests per actor, even when the text differs', async () => {
    const token = await actor()
    let release!: () => void
    let started!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    const seen = new Promise<void>(resolve => { started = resolve })
    behaviour = async () => { started(); await pending; return sampleDraftOutput() }
    const first = suggest(token).then(response => response)
    await seen
    try {
      const second = await suggest(token, 'merchant', { description: '另一个商品' }).expect(409)
      expect(second.body.error.code).toBe('AI_GENERATION_IN_PROGRESS')
      expect(calls).toHaveLength(1)
    } finally { release() }
    expect((await first).status).toBe(200)
  })

  it('records timeout and malformed output as failures without business writes', async () => {
    const token = await actor()
    config.ai.timeoutMs = 20
    behaviour = async request => new Promise((_, reject) => request.signal.addEventListener('abort', () => reject(new LlmError('timeout')), { once: true }))
    expect((await suggest(token).expect(504)).body.error.code).toBe('AI_TIMEOUT')
    behaviour = async () => ({ ...sampleDraftOutput(), price: 1 })
    expect((await suggest(token).expect(502)).body.error.code).toBe('AI_OUTPUT_INVALID')
    expect(await prisma.aiGeneration.count({ where: { status: 'failed' } })).toBe(2)
    expect(await prisma.product.count()).toBe(0)
  })

  it('creates only through the existing draft API after an explicit normal create request', async () => {
    const token = await actor()
    const res = await suggest(token).expect(200)
    const suggestion = res.body.suggestion
    const created = await api.post('/api/merchant/products').set(authHeader(token)).send({
      editorVersion: 2, templateKey: suggestion.templateKey, templateVersion: 1,
      name: suggestion.name, categoryId: suggestion.categoryId, description: suggestion.description,
      richDescription: `<p>${suggestion.introduction}</p>`, descriptionImages: [], images: [], visibility: 'members_only',
      attributes: suggestion.attributes, details: suggestion.details, purchaseForm: [],
      offers: [{ name: suggestion.offerName, price: 100, originalPrice: null, attributes: suggestion.offerAttributes,
        deliveryMode: 'instant_fixed', stockMode: 'limited', validityDays: null, fixedContentType: 'text',
        fixedContent: null, fixedFileId: null, fixedStructuredContent: null, deliveryFields: null, autoProvision: false }],
    }).expect(201)
    expect(created.body.status).toBe('draft')
    const product = await prisma.product.findUniqueOrThrow({ where: { id: created.body.id } })
    expect(product).toMatchObject({ status: 'draft', stock: 0, stockMode: 'limited', visibility: 'members_only' })
    expect(product.richDescription).toContain(suggestion.introduction)
    await prisma.systemConfig.update({ where: { key: 'aiProductCopilotDailyQuotaMerchant' }, data: { value: 1 } })
    const exhausted = await api.post(`/api/merchant/products/${product.id}/content-suggestions`).set(authHeader(token))
      .send({ expectedContentVersion: 1 }).expect(429)
    expect(exhausted.body.error.code).toBe('AI_QUOTA_EXCEEDED')
  })
})
