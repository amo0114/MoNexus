// SPEC-AI-PRODUCT-001 §13 (backend integration) + SPEC-AI-001 §17. The LLM is
// always the test double; CI never calls a real provider.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { config } from '../config/index.js'
import { businessDateString, businessDayStartUtc } from '../lib/businessTime.js'
import { LlmError, setLlmProviderForTests, type LlmProvider, type LlmStructuredRequest } from '../lib/ai/provider.js'
import { prisma } from '../lib/prisma.js'
import { EXTERNAL_CATALOG_PROVIDER } from '../modules/catalog/constants.js'
import { EMPTY_PRODUCT_DETAILS } from '../modules/catalog/templates/types.js'
import { api, authHeader, createTestMerchant, createTestUser, loginAs } from './helpers.js'
import { getActiveCategoryIdByLabel } from './catalogFixture.js'

const SENTINEL_NAME = 'SENTINEL_PRODUCT_NAME_4711'
const SENTINEL_NOTES = 'SENTINEL_NOTES_4711'
const SENTINEL_SECRET = 'SENTINEL_FIXED_SECRET_4711'

type Behaviour = (req: LlmStructuredRequest) => Promise<unknown>

const calls: LlmStructuredRequest[] = []
let behaviour: Behaviour = async () => validOutput()

const fakeProvider: LlmProvider = {
  name: 'test-double',
  async generateStructured(req) {
    calls.push(req)
    const output = await behaviour(req)
    return { output, usage: { inputTokens: 120, outputTokens: 80 }, model: 'gpt-6-luna-test' }
  },
}

function validOutput() {
  return {
    description: { text: '下单后自动交付的学习指引。', claims: [{ kind: 'delivery_method', span: '下单后自动交付', factRef: 'common.deliveryMethod' }] },
    highlights: [{ text: '内容循序渐进', claims: [] }, { text: '官方正品', claims: [] }],
    usageInstructions: null,
    purchaseNotes: { text: '购买前请确认内容适用于你的学习阶段。', claims: [] },
    afterSalesInstructions: { text: '使用过程中如遇问题，可通过订单售后入口提交问题，具体处理以平台实际规则为准。', claims: [] },
    faq: null,
    issues: [{ kind: 'missing', field: 'usageInstructions', message: '未说明兑换入口位置', evidence: null }],
  }
}

const savedAi = { ...config.ai }

async function setQuota(key: 'aiProductCopilotDailyQuotaAdmin' | 'aiProductCopilotDailyQuotaMerchant', value: number) {
  await prisma.systemConfig.upsert({ where: { key }, create: { key, value }, update: { value } })
}

async function merchantWithProduct(email: string, options: { templated?: boolean } = {}) {
  const { merchant } = await createTestMerchant(email, 'pass123', { role: 'merchant', status: 'active', name: `商家-${email}` })
  const { accessToken } = await loginAs(email, 'pass123')
  const categoryId = await getActiveCategoryIdByLabel('充值卡密')
  const body = options.templated === false
    ? { name: SENTINEL_NAME, categoryId, price: 80, deliveryMode: 'instant_inventory', stockMode: 'limited' }
    : {
        editorVersion: 2,
        templateKey: 'fixed_content',
        templateVersion: 1,
        name: SENTINEL_NAME,
        categoryId,
        description: '旧简介',
        richDescription: null,
        descriptionImages: [],
        images: [],
        visibility: 'members_only',
        attributes: { contentCategory: '学习指引', applicableScope: '入门学习' },
        details: EMPTY_PRODUCT_DETAILS,
        purchaseForm: [],
        offers: [{
          name: '完整版',
          price: 100,
          originalPrice: null,
          attributes: { contentScope: '完整文字指引' },
          deliveryMode: 'instant_fixed',
          stockMode: 'unlimited',
          validityDays: null,
          fixedContentType: 'text',
          fixedContent: SENTINEL_SECRET,
          fixedFileId: null,
          fixedStructuredContent: null,
          deliveryFields: null,
          autoProvision: false,
        }],
      }
  const created = await api.post('/api/merchant/products').set(authHeader(accessToken)).send(body).expect(201)
  return { token: accessToken, merchantId: merchant.id, productId: created.body.id as number }
}

function suggest(token: string, productId: number, body: Record<string, unknown> = {}, actor: 'merchant' | 'admin' = 'merchant') {
  return api.post(`/api/${actor}/products/${productId}/content-suggestions`)
    .set(authHeader(token))
    .send({ expectedContentVersion: 1, ...body })
}

beforeEach(async () => {
  calls.length = 0
  behaviour = async () => validOutput()
  setLlmProviderForTests(fakeProvider)
  config.ai.enabled = true
  config.ai.productCopilotEnabled = true
  config.ai.timeoutMs = savedAi.timeoutMs
  await setQuota('aiProductCopilotDailyQuotaMerchant', 5)
  await setQuota('aiProductCopilotDailyQuotaAdmin', 5)
})

afterEach(() => {
  setLlmProviderForTests(null)
  Object.assign(config.ai, savedAi)
})

describe('product content copilot — happy path and metadata', () => {
  it('returns validated suggestions and records only metadata', async () => {
    const { token, productId } = await merchantWithProduct('copilot-ok@test.local')
    const res = await suggest(token, productId, { sourceNotes: SENTINEL_NOTES }).expect(200)

    expect(res.body).toMatchObject({
      basedOnContentVersion: 1,
      promptVersion: 'product-content@1',
      validatorVersion: 'product-content-validator@1',
    })
    expect(res.body.fields.description).toEqual({ status: 'suggested', value: '下单后自动交付的学习指引。', rejectedItemCount: 0 })
    expect(res.body.fields.highlights).toEqual({ status: 'suggested', value: ['内容循序渐进'], rejectedItemCount: 1 })
    expect(res.body.fields.usageInstructions.status).toBe('not_generated')
    expect(JSON.stringify(res.body)).not.toContain('claims')

    // The provider received the frozen call shape and an AI-safe context only.
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ model: 'gpt-6-luna', reasoningEffort: 'none', schemaName: 'product_content_suggestion' })
    const sent = JSON.stringify(calls[0].input)
    expect(sent).toContain(SENTINEL_NOTES)
    expect(sent).not.toContain(SENTINEL_SECRET)
    expect(sent).not.toContain('"price"')

    const row = await prisma.aiGeneration.findUniqueOrThrow({ where: { id: res.body.generationId } })
    expect(row).toMatchObject({
      feature: 'product_content_copilot',
      actorRole: 'merchant',
      targetType: 'product',
      targetId: productId,
      provider: 'test-double',
      model: 'gpt-6-luna-test',
      status: 'succeeded',
      inputTokens: 120,
      outputTokens: 80,
      suggestedFieldCount: 4,
      acceptedFieldCount: null,
    })
    expect(row.inputHash).toMatch(/^[0-9a-f]{64}$/)
    const counts = row.issueCounts as Record<string, number>
    expect(counts.risky_claim).toBe(1)
    expect(counts.missing).toBeGreaterThanOrEqual(1)
    const persisted = JSON.stringify(row)
    for (const sentinel of [SENTINEL_NAME, SENTINEL_NOTES, SENTINEL_SECRET, '内容循序渐进']) {
      expect(persisted).not.toContain(sentinel)
    }
  })

  it('exposes the editor capability only when flags, template and quota allow', async () => {
    const { token, productId } = await merchantWithProduct('copilot-cap@test.local')
    const editor = await api.get(`/api/merchant/products/${productId}/editor`).set(authHeader(token)).expect(200)
    expect(editor.body.capabilities.aiContentSuggestion).toBe(true)

    await setQuota('aiProductCopilotDailyQuotaMerchant', 0)
    const noQuota = await api.get(`/api/merchant/products/${productId}/editor`).set(authHeader(token)).expect(200)
    expect(noQuota.body.capabilities.aiContentSuggestion).toBe(false)

    await setQuota('aiProductCopilotDailyQuotaMerchant', 5)
    config.ai.productCopilotEnabled = false
    const off = await api.get(`/api/merchant/products/${productId}/editor`).set(authHeader(token)).expect(200)
    expect(off.body.capabilities.aiContentSuggestion).toBe(false)
  })
})

describe('product content copilot — preconditions (§4)', () => {
  it('returns 404 when the feature flag is off, without calling the provider', async () => {
    const { token, productId } = await merchantWithProduct('copilot-flag@test.local')
    config.ai.productCopilotEnabled = false
    await suggest(token, productId).expect(404)
    config.ai.productCopilotEnabled = true
    config.ai.enabled = false
    await suggest(token, productId).expect(404)
    expect(calls).toHaveLength(0)
  })

  it("hides another merchant's product as 404", async () => {
    const owner = await merchantWithProduct('copilot-owner@test.local')
    const other = await merchantWithProduct('copilot-other@test.local')
    await suggest(other.token, owner.productId).expect(404)
    expect(calls).toHaveLength(0)
    expect(await prisma.aiGeneration.count()).toBe(0)
  })

  it('rejects untemplated, archived and stale products', async () => {
    const legacy = await merchantWithProduct('copilot-legacy@test.local', { templated: false })
    const legacyRes = await suggest(legacy.token, legacy.productId).expect(409)
    expect(legacyRes.body.error.code).toBe('AI_PRODUCT_TEMPLATE_REQUIRED')

    const stale = await merchantWithProduct('copilot-stale@test.local')
    const staleRes = await suggest(stale.token, stale.productId, { expectedContentVersion: 9 }).expect(409)
    expect(staleRes.body.error.code).toBe('PRODUCT_CONTENT_CHANGED')

    await prisma.product.update({ where: { id: stale.productId }, data: { archivedAt: new Date() } })
    const archived = await suggest(stale.token, stale.productId).expect(409)
    expect(archived.body.error.code).toBe('PRODUCT_ARCHIVED')
    expect(calls).toHaveLength(0)
  })

  it('refuses an oversized context with 422 before any provider call or quota use', async () => {
    const { token, productId } = await merchantWithProduct('copilot-oversized@test.local')
    await prisma.offer.updateMany({
      where: { productId },
      data: { attributes: { contentScope: '范'.repeat(500) } },
    })
    await prisma.offer.createMany({
      data: Array.from({ length: 49 }, (_, index) => ({
        productId,
        name: `规格${index}`,
        price: 100,
        deliveryMode: 'instant_fixed',
        stockMode: 'unlimited',
        fixedContent: 'x',
        sortOrder: index + 1,
        attributes: { contentScope: '范'.repeat(500) },
      })),
    })
    const res = await suggest(token, productId).expect(422)
    expect(res.body.error.code).toBe('AI_CONTEXT_TOO_LARGE')
    expect(calls).toHaveLength(0)
    expect(await prisma.aiGeneration.count()).toBe(0)
  })

  it('rejects useUpstreamDescription on the merchant route', async () => {
    const { token, productId } = await merchantWithProduct('copilot-upstream@test.local')
    await suggest(token, productId, { useUpstreamDescription: true }).expect(400)
  })
})

describe('product content copilot — quota, concurrency and failures (SPEC-AI-001 §9 / §11)', () => {
  it('enforces the per-role daily quota, counting failed attempts', async () => {
    const { token, productId } = await merchantWithProduct('copilot-quota@test.local')
    await setQuota('aiProductCopilotDailyQuotaMerchant', 2)
    behaviour = async () => { throw new LlmError('unavailable', 503) }
    const failed = await suggest(token, productId).expect(502)
    expect(failed.body.error.code).toBe('AI_PROVIDER_ERROR')
    behaviour = async () => validOutput()
    await suggest(token, productId).expect(200)
    const exhausted = await suggest(token, productId).expect(429)
    expect(exhausted.body.error.code).toBe('AI_QUOTA_EXCEEDED')
    expect(calls).toHaveLength(2)

    await setQuota('aiProductCopilotDailyQuotaMerchant', 0)
    await suggest(token, productId).expect(429)
  })

  it('counts only attempts since the Shanghai day start', async () => {
    const { token, productId, merchantId } = await merchantWithProduct('copilot-day@test.local')
    const merchant = await prisma.merchant.findUniqueOrThrow({ where: { id: merchantId } })
    await setQuota('aiProductCopilotDailyQuotaMerchant', 1)
    const dayStart = businessDayStartUtc(businessDateString(new Date()))
    await prisma.aiGeneration.create({
      data: {
        feature: 'product_content_copilot',
        actorUserId: merchant.userId,
        actorRole: 'merchant',
        targetType: 'product',
        targetId: productId,
        provider: 'test-double',
        model: 'gpt-6-luna',
        promptVersion: 'product-content@1',
        validatorVersion: 'product-content-validator@1',
        inputHash: 'a'.repeat(64),
        status: 'succeeded',
        createdAt: new Date(dayStart.getTime() - 1),
      },
    })
    await suggest(token, productId).expect(200)
    await suggest(token, productId).expect(429)
  })

  it('maps a provider timeout to 504 and records the failure', async () => {
    const { token, productId } = await merchantWithProduct('copilot-timeout@test.local')
    config.ai.timeoutMs = 50
    behaviour = req => new Promise((_resolve, reject) => {
      req.signal.addEventListener('abort', () => reject(new Error('aborted by caller')))
    })
    const res = await suggest(token, productId).expect(504)
    expect(res.body.error.code).toBe('AI_TIMEOUT')
    const row = await prisma.aiGeneration.findFirstOrThrow()
    expect(row).toMatchObject({ status: 'failed', errorCode: 'AI_TIMEOUT' })
  })

  it('rejects structurally invalid output as AI_OUTPUT_INVALID', async () => {
    const { token, productId } = await merchantWithProduct('copilot-invalid@test.local')
    behaviour = async () => ({ description: 'not a unit' })
    const res = await suggest(token, productId).expect(502)
    expect(res.body.error.code).toBe('AI_OUTPUT_INVALID')
    expect(JSON.stringify(res.body)).not.toContain('not a unit')
  })

  it('refuses a second concurrent generation for the same product', async () => {
    const { token, productId } = await merchantWithProduct('copilot-inflight@test.local')
    let release: () => void = () => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    let started: () => void = () => {}
    const providerStarted = new Promise<void>(resolve => { started = resolve })
    behaviour = async () => {
      started()
      await gate
      return validOutput()
    }
    const first = suggest(token, productId).then(res => res)
    await providerStarted
    const second = await suggest(token, productId).expect(409)
    expect(second.body.error.code).toBe('AI_GENERATION_IN_PROGRESS')
    release()
    expect((await first).status).toBe(200)
  })
})

describe('product content copilot — admin and Xboard', () => {
  async function adminToken() {
    await createTestUser('copilot-admin@test.local', 'admin123', 'admin')
    const { accessToken } = await loginAs('copilot-admin@test.local', 'admin123')
    return accessToken
  }

  async function xboardProduct(adminId: number) {
    const categoryId = await getActiveCategoryIdByLabel('网络节点')
    const product = await prisma.product.create({
      data: {
        name: 'Xboard 线路',
        type: '网络节点',
        categoryId,
        price: 100,
        status: 'draft',
        merchantId: null,
        templateKey: 'subscription',
        templateVersion: 1,
        attributes: { serviceName: '示例线路', serviceScope: '线路订阅' },
        visibility: 'members_only',
      },
    })
    await prisma.offer.create({
      data: {
        productId: product.id,
        name: '月付',
        isDefault: true,
        price: 100,
        deliveryMode: 'manual_service',
        stockMode: 'unlimited',
        validityDays: 30,
        externalIntegration: 'faka_bridge',
        externalSku: 'plan-77-monthly',
        attributes: { entitlementSummary: '月付套餐' },
      },
    })
    await prisma.externalCatalogLink.create({
      data: {
        provider: EXTERNAL_CATALOG_PROVIDER.FAKA_BRIDGE,
        externalProductId: '77',
        productId: product.id,
        sourceHash: 'b'.repeat(64),
        sourceSnapshot: { planId: 77, name: '线路', periods: [{ period: 'monthly', price: 10, skuAlias: 'plan-77-monthly' }], namedSkus: [] },
        idempotencyKey: 'copilot-xboard',
        requestHash: 'c'.repeat(64),
        importedByUserId: adminId,
        latestDescriptionText: '不限流量 SENTINEL_UPSTREAM',
      },
    })
    return product.id
  }

  it('projects Xboard periods for admins and reads upstream text only on request', async () => {
    const token = await adminToken()
    const admin = await prisma.user.findUniqueOrThrow({ where: { email: 'copilot-admin@test.local' } })
    const productId = await xboardProduct(admin.id)

    await suggest(token, productId, {}, 'admin').expect(200)
    const withoutUpstream = JSON.stringify(calls[0].input)
    expect(withoutUpstream).toContain('"xboardPeriod":"monthly"')
    expect(withoutUpstream).not.toContain('SENTINEL_UPSTREAM')
    expect(withoutUpstream).not.toContain('plan-77-monthly')

    const res = await suggest(token, productId, { useUpstreamDescription: true }, 'admin').expect(200)
    expect(JSON.stringify(calls[1].input)).toContain('SENTINEL_UPSTREAM')
    expect(res.body.issues.some((issue: { kind: string; field: string | null }) => issue.kind === 'risky_claim' && issue.field == null)).toBe(true)
    const row = await prisma.aiGeneration.findUniqueOrThrow({ where: { id: res.body.generationId } })
    expect(row.actorRole).toBe('admin')
  })

  it('rejects useUpstreamDescription for products without an Xboard link', async () => {
    const token = await adminToken()
    const { productId } = await merchantWithProduct('copilot-admin-target@test.local')
    await suggest(token, productId, { useUpstreamDescription: true }, 'admin').expect(400)
    await suggest(token, productId, {}, 'admin').expect(200)
  })
})

describe('product content copilot — applied telemetry (CP-12)', () => {
  it('records appliedFieldCount for the owner within bounds only', async () => {
    const owner = await merchantWithProduct('copilot-applied@test.local')
    const other = await merchantWithProduct('copilot-applied-other@test.local')
    const res = await suggest(owner.token, owner.productId).expect(200)
    const path = `/api/merchant/products/${owner.productId}/content-suggestions/${res.body.generationId}/applied`

    await api.post(path).set(authHeader(other.token)).send({ appliedFieldCount: 1 }).expect(404)
    await api.post(path).set(authHeader(owner.token)).send({ appliedFieldCount: 0 }).expect(400)
    await api.post(path).set(authHeader(owner.token)).send({ appliedFieldCount: 5 }).expect(400)
    await api.post(path).set(authHeader(owner.token)).send({ appliedFields: ['description'] }).expect(400)
    await api.post(path).set(authHeader(owner.token)).send({ appliedFieldCount: 2 }).expect(204)

    const row = await prisma.aiGeneration.findUniqueOrThrow({ where: { id: res.body.generationId } })
    expect(row.acceptedFieldCount).toBe(2)
  })
})
