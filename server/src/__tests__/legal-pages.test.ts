import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { config } from '../config/index.js'
import { prisma } from '../lib/prisma.js'
import {
  __resetLegalRegistryForTests,
  __setLegalRegistryForTests,
  listLegalDocumentSummaries,
  resolveLegalDocument,
  type LegalDocumentDefinition,
} from '../modules/legal/registry.js'
import { BUILTIN_LEGAL_DOCUMENTS } from '../modules/legal/documents.js'
import { computeRequestDigest } from '../modules/orders/idempotency.js'
import { EVIDENCE_RETENTION_DAYS } from '../modules/legal/service.js'
import { __runLegalRetentionBatchForTests } from '../modules/legal/cron.js'
import {
  api,
  authHeader,
  createTestProduct,
  createTestUser,
  loginAs,
} from './helpers.js'

/**
 * SPEC-LEGAL-001：法律页面与协议同意的全链路测试。
 * 覆盖：注册表/公开 API、注册同意（REQUIRED/STALE/落证）、下单确认
 * （同事务/幂等/STALE）、留存 cron 匿名化。
 */

type LegalConfigSnapshot = {
  enabled: boolean
  enforcement: 'off' | 'enforce'
  fixturePath: string | undefined
}

function snapshotLegalConfig(): LegalConfigSnapshot {
  return {
    enabled: config.legalPages.enabled,
    enforcement: config.legalPages.enforcement,
    fixturePath: config.legalPages.fixturePath,
  }
}

function restoreLegalConfig(snapshot: LegalConfigSnapshot) {
  config.legalPages.enabled = snapshot.enabled
  config.legalPages.enforcement = snapshot.enforcement
  config.legalPages.fixturePath = snapshot.fixturePath
}

function enableLegal(enforcement: 'off' | 'enforce' = 'enforce') {
  config.legalPages.enabled = true
  config.legalPages.enforcement = enforcement
}

/** 当前注册表的内置版本（草案均为 1.0）。 */
function currentRegistrationAgreements() {
  return { terms: '1.0', privacy: '1.0' }
}

function currentOrderAgreements() {
  return { terms: '1.0', refund: '1.0' }
}

/** 模拟部署升级：terms/refund 追加 1.1 版本并切换 currentVersion。 */
function bumpedOrderDocumentDefinitions(): LegalDocumentDefinition[] {
  return BUILTIN_LEGAL_DOCUMENTS.map(definition => {
    if (definition.slug !== 'terms' && definition.slug !== 'refund') return definition
    return {
      ...definition,
      currentVersion: '1.1',
      versions: [
        ...definition.versions,
        {
          version: '1.1',
          updatedAt: '2026-08-06',
          sections: [{ heading: '修订说明', paragraphs: ['版本 1.1：条款修订。'] }],
        },
      ],
    }
  })
}

let original: LegalConfigSnapshot

beforeEach(() => {
  original = snapshotLegalConfig()
})

afterEach(() => {
  restoreLegalConfig(original)
  __resetLegalRegistryForTests()
})

describe('registry & public API', () => {
  it('computes a stable sha256 over the canonical public payload', () => {
    const doc = resolveLegalDocument('terms')
    expect(doc).not.toBeNull()
    expect(doc!.version).toBe('1.0')
    expect(doc!.contentHash).toMatch(/^[0-9a-f]{64}$/)

    const canonical = JSON.stringify({
      slug: doc!.slug,
      title: doc!.title,
      version: doc!.version,
      updatedAt: doc!.updatedAt,
      sections: doc!.sections,
    })
    const recomputed = createHash('sha256').update(canonical, 'utf8').digest('hex')
    expect(doc!.contentHash).toBe(recomputed)
  })

  it('exposes all five documents with current versions', () => {
    const summaries = listLegalDocumentSummaries()
    expect(summaries.map(s => s.slug).sort()).toEqual(
      ['about', 'points-rules', 'privacy', 'refund', 'terms'].sort(),
    )
    for (const summary of summaries) {
      expect(summary.contentHash).toMatch(/^[0-9a-f]{64}$/)
      expect(summary.version).toBe('1.0')
    }
  })

  it('returns 404 for unknown slug or version', () => {
    expect(resolveLegalDocument('nonsense')).toBeNull()
    expect(resolveLegalDocument('terms', '9.9')).toBeNull()
    expect(resolveLegalDocument('terms', '1.0')).not.toBeNull()
  })

  it('hides the API entirely when the feature is disabled', async () => {
    config.legalPages.enabled = false
    await api.get('/api/legal/documents').expect(404)
    await api.get('/api/legal/documents/terms').expect(404)
  })

  it('serves list and document endpoints when enabled', async () => {
    enableLegal()
    const list = await api.get('/api/legal/documents').expect(200)
    expect(list.body.documents).toHaveLength(5)
    const termsSummary = list.body.documents.find((d: { slug: string }) => d.slug === 'terms')
    expect(termsSummary).toBeDefined()
    expect(termsSummary.sections).toBeUndefined() // 列表不回内容体

    const doc = await api.get('/api/legal/documents/terms').expect(200)
    expect(doc.body.slug).toBe('terms')
    expect(doc.body.sections.length).toBeGreaterThan(0)
    expect(doc.body.contentHash).toBe(termsSummary.contentHash)

    const pinned = await api.get('/api/legal/documents/terms?version=1.0').expect(200)
    expect(pinned.body.contentHash).toBe(doc.body.contentHash)

    await api.get('/api/legal/documents/terms?version=9.9').expect(404)
    await api.get('/api/legal/documents/nonsense').expect(404)
  })

  it('mirrors the legal requirement in public registration status', async () => {
    config.legalPages.enabled = false
    const off = await api.get('/api/auth/registration-status').expect(200)
    expect(off.body.legalRequirement).toBeNull()

    enableLegal()
    const on = await api.get('/api/auth/registration-status').expect(200)
    expect(on.body.legalRequirement.required).toHaveLength(2)
    // 复审 P2：强制语义随清单下发，记录模式（off）客户端不得门控提交。
    expect(on.body.legalRequirement.enforcement).toBe('enforce')
    const documents = on.body.legalRequirement.required.map((r: { document: string }) => r.document).sort()
    expect(documents).toEqual(['privacy', 'terms'])
    for (const item of on.body.legalRequirement.required) {
      expect(item.version).toBe('1.0')
      expect(item.contentHash).toMatch(/^[0-9a-f]{64}$/)
    }

    enableLegal('off')
    const recordOnly = await api.get('/api/auth/registration-status').expect(200)
    expect(recordOnly.body.legalRequirement.enforcement).toBe('off')
    expect(recordOnly.body.legalRequirement.required).toHaveLength(2)
  })
})

describe('registration consent', () => {
  const email = 'legal-register@test.local'

  it('rejects registration without agreements in enforce mode (zero side effects)', async () => {
    enableLegal('enforce')
    const res = await api.post('/api/auth/register').send({ email, password: 'pass123' })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('LEGAL_AGREEMENT_REQUIRED')
    expect(await prisma.user.findUnique({ where: { email } })).toBeNull()
  })

  it('rejects stale agreement versions with the current versions in details', async () => {
    enableLegal('enforce')
    const res = await api.post('/api/auth/register').send({
      email,
      password: 'pass123',
      agreements: { terms: '0.9', privacy: '1.0' },
    })
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('LEGAL_AGREEMENT_STALE')
    const fields = (res.body.error.details as Array<{ field: string; message: string }>).map(d => d.field).sort()
    expect(fields).toEqual(['agreements.privacy', 'agreements.terms'])
    expect(await prisma.user.findUnique({ where: { email } })).toBeNull()
  })

  it('rejects unknown document slugs', async () => {
    enableLegal('enforce')
    const res = await api.post('/api/auth/register').send({
      email,
      password: 'pass123',
      agreements: { ...currentRegistrationAgreements(), 'fake-doc': '1.0' },
    })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('BAD_REQUEST')
  })

  it('records consent evidence with the account in enforce mode', async () => {
    enableLegal('enforce')
    const res = await api
      .post('/api/auth/register')
      .set('User-Agent', 'legal-test-agent/1.0')
      .send({ email, password: 'pass123', agreements: currentRegistrationAgreements() })
    expect(res.status).toBe(201)

    const user = await prisma.user.findUniqueOrThrow({ where: { email } })
    const consents = await prisma.userAgreementConsent.findMany({
      where: { userId: user.id },
      orderBy: { document: 'asc' },
    })
    expect(consents.map(c => c.document)).toEqual(['privacy', 'terms'])
    for (const consent of consents) {
      expect(consent.version).toBe('1.0')
      const doc = resolveLegalDocument(consent.document, consent.version)
      expect(consent.contentHash).toBe(doc!.contentHash)
      expect(consent.userAgent).toBe('legal-test-agent/1.0')
      expect(consent.retentionUntil).not.toBeNull()
      // 应用时钟（retentionUntil）与数据库时钟（consentedAt default now()）
      // 允许秒级偏差，窗口本身必须等于留存天数。
      const windowMs = consent.retentionUntil!.getTime() - consent.consentedAt.getTime()
      expect(Math.abs(windowMs - EVIDENCE_RETENTION_DAYS * 24 * 60 * 60 * 1000)).toBeLessThan(5_000)
    }
  })

  it('records but does not require agreements in off mode', async () => {
    enableLegal('off')
    const without = await api.post('/api/auth/register').send({ email, password: 'pass123' })
    expect(without.status).toBe(201)
    const user = await prisma.user.findUniqueOrThrow({ where: { email } })
    expect(await prisma.userAgreementConsent.count({ where: { userId: user.id } })).toBe(0)

    const withAgreements = await api.post('/api/auth/register').send({
      email: 'legal-register-2@test.local',
      password: 'pass123',
      agreements: { terms: '1.0' }, // off 模式：只记录携带的部分
    })
    expect(withAgreements.status).toBe(201)
    const user2 = await prisma.user.findUniqueOrThrow({ where: { email: 'legal-register-2@test.local' } })
    const consents = await prisma.userAgreementConsent.findMany({ where: { userId: user2.id } })
    expect(consents).toHaveLength(1)
    expect(consents[0].document).toBe('terms')
  })

  it('ignores agreements entirely when the feature is disabled', async () => {
    config.legalPages.enabled = false
    const res = await api.post('/api/auth/register').send({
      email,
      password: 'pass123',
      agreements: currentRegistrationAgreements(),
    })
    expect(res.status).toBe(201)
    const user = await prisma.user.findUniqueOrThrow({ where: { email } })
    expect(await prisma.userAgreementConsent.count({ where: { userId: user.id } })).toBe(0)
  })

  it('rejects stale versions of non-required documents too (LEG-06)', async () => {
    enableLegal('enforce')
    // about 不是注册必备文档，但携带的旧版本同样必须被注册表裁决——
    // 否则"确认过 about@0.1"会被静默丢弃，证据失真。
    const res = await api.post('/api/auth/register').send({
      email,
      password: 'pass123',
      agreements: { ...currentRegistrationAgreements(), about: '0.1' },
    })
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('LEGAL_AGREEMENT_STALE')
    const fields = (res.body.error.details as Array<{ field: string }>).map(d => d.field)
    expect(fields).toContain('agreements.about')
    expect(await prisma.user.findUnique({ where: { email } })).toBeNull()
  })

  it('records extra current-version documents provided alongside the required ones', async () => {
    enableLegal('enforce')
    const res = await api.post('/api/auth/register').send({
      email,
      password: 'pass123',
      agreements: { ...currentRegistrationAgreements(), about: '1.0' },
    })
    expect(res.status).toBe(201)
    const user = await prisma.user.findUniqueOrThrow({ where: { email } })
    const consents = await prisma.userAgreementConsent.findMany({
      where: { userId: user.id },
      orderBy: { document: 'asc' },
    })
    expect(consents.map(c => c.document)).toEqual(['about', 'privacy', 'terms'])
  })
})

describe('order acceptance', () => {
  async function setupBuyerAndProduct() {
    const { user, password } = await createTestUser('legal-buyer@test.local', 'buyerpass123', 'user', 5000)
    await prisma.user.update({ where: { id: user.id }, data: { emailVerified: new Date() } })
    const product = await createTestProduct('法律测试商品', 100, 5)
    const { accessToken } = await loginAs('legal-buyer@test.local', 'buyerpass123')
    return { user, product, accessToken }
  }

  it('rejects order creation without agreements in enforce mode', async () => {
    enableLegal('enforce')
    const { product, accessToken } = await setupBuyerAndProduct()
    const res = await api
      .post('/api/orders')
      .set(authHeader(accessToken))
      .send({ productId: product.id })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('LEGAL_AGREEMENT_REQUIRED')
    expect(await prisma.order.count()).toBe(0)
  })

  it('rejects stale agreement versions (409 contract)', async () => {
    enableLegal('enforce')
    const { product, accessToken } = await setupBuyerAndProduct()
    const res = await api
      .post('/api/orders')
      .set(authHeader(accessToken))
      .send({ productId: product.id, agreementVersions: { terms: '0.9', refund: '1.0' } })
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('LEGAL_AGREEMENT_STALE')
    expect(await prisma.order.count()).toBe(0)
  })

  it('records acceptances in the same transaction as the order', async () => {
    enableLegal('enforce')
    const { user, product, accessToken } = await setupBuyerAndProduct()
    const res = await api
      .post('/api/orders')
      .set(authHeader(accessToken))
      .set('User-Agent', 'legal-order-agent/2.0')
      .send({ productId: product.id, agreementVersions: currentOrderAgreements() })
    expect(res.status).toBe(201)

    const acceptances = await prisma.orderAgreementAcceptance.findMany({
      where: { orderId: res.body.orderId },
      orderBy: { document: 'asc' },
    })
    expect(acceptances.map(a => a.document)).toEqual(['refund', 'terms'])
    for (const acceptance of acceptances) {
      expect(acceptance.userId).toBe(user.id)
      expect(acceptance.version).toBe('1.0')
      const doc = resolveLegalDocument(acceptance.document, acceptance.version)
      expect(acceptance.contentHash).toBe(doc!.contentHash)
      expect(acceptance.userAgent).toBe('legal-order-agent/2.0')
      expect(acceptance.retentionUntil).not.toBeNull()
    }
  })

  it('keeps exactly one acceptance set across idempotent replays', async () => {
    enableLegal('enforce')
    const { product, accessToken } = await setupBuyerAndProduct()
    const key = crypto.randomUUID()
    const payload = { productId: product.id, agreementVersions: currentOrderAgreements() }

    const first = await api
      .post('/api/orders')
      .set(authHeader(accessToken))
      .set('Idempotency-Key', key)
      .send(payload)
    expect(first.status).toBe(201)

    const replay = await api
      .post('/api/orders')
      .set(authHeader(accessToken))
      .set('Idempotency-Key', key)
      .send(payload)
    expect(replay.status).toBe(201)
    expect(replay.body.idempotentReplay).toBe(true)
    expect(replay.body.orderId).toBe(first.body.orderId)

    expect(
      await prisma.orderAgreementAcceptance.count({ where: { orderId: first.body.orderId } }),
    ).toBe(2)
  })

  it('treats the same idempotency key with different agreement versions as a different intent', async () => {
    // off 模式：部分/完整确认都能通过协议校验，从而抵达幂等指纹比对——
    // 同 key 换确认内容必须 409（用户确认的是不同文本 ≠ 同一结算意图）。
    enableLegal('off')
    const { product, accessToken } = await setupBuyerAndProduct()
    const key = crypto.randomUUID()
    const first = await api
      .post('/api/orders')
      .set(authHeader(accessToken))
      .set('Idempotency-Key', key)
      .send({ productId: product.id, agreementVersions: currentOrderAgreements() })
    expect(first.status).toBe(201)

    const conflictRes = await api
      .post('/api/orders')
      .set(authHeader(accessToken))
      .set('Idempotency-Key', key)
      .send({ productId: product.id, agreementVersions: { terms: '1.0' } })
    expect(conflictRes.status).toBe(409)
    expect(conflictRes.body.error.code).toBe('CONFLICT')
  })

  it('creates orders without agreements when the feature is disabled', async () => {
    config.legalPages.enabled = false
    const { product, accessToken } = await setupBuyerAndProduct()
    const res = await api
      .post('/api/orders')
      .set(authHeader(accessToken))
      .send({ productId: product.id })
    expect(res.status).toBe(201)
    expect(await prisma.orderAgreementAcceptance.count()).toBe(0)
  })

  it('replays a completed order under the original key after an agreement upgrade (P1 regression)', async () => {
    enableLegal('enforce')
    const { product, accessToken } = await setupBuyerAndProduct()
    const key = crypto.randomUUID()
    const payload = { productId: product.id, agreementVersions: currentOrderAgreements() }

    const first = await api
      .post('/api/orders')
      .set(authHeader(accessToken))
      .set('Idempotency-Key', key)
      .send(payload)
    expect(first.status).toBe(201)

    // 部署升级：terms/refund 切到 1.1。客户端此时丢失首个响应，用原 key +
    // 原版本重试——必须重放原订单，而不是被 LEGAL_AGREEMENT_STALE 挡下
    // （否则前端换新键重确认，同一意图产生第二笔订单）。
    __setLegalRegistryForTests(bumpedOrderDocumentDefinitions())

    const replay = await api
      .post('/api/orders')
      .set(authHeader(accessToken))
      .set('Idempotency-Key', key)
      .send(payload)
    expect(replay.status).toBe(201)
    expect(replay.body.idempotentReplay).toBe(true)
    expect(replay.body.orderId).toBe(first.body.orderId)
    expect(await prisma.order.count()).toBe(1)
    expect(
      await prisma.orderAgreementAcceptance.count({ where: { orderId: first.body.orderId } }),
    ).toBe(2)

    // 对称：原 key + 新版本 = 不同意图，指纹不符 409，绝不静默重放。
    const conflictRes = await api
      .post('/api/orders')
      .set(authHeader(accessToken))
      .set('Idempotency-Key', key)
      .send({ productId: product.id, agreementVersions: { terms: '1.1', refund: '1.1' } })
    expect(conflictRes.status).toBe(409)
    expect(conflictRes.body.error.code).toBe('CONFLICT')

    // 而新 key + 旧版本则正常走协议校验：STALE。
    const stale = await api
      .post('/api/orders')
      .set(authHeader(accessToken))
      .set('Idempotency-Key', crypto.randomUUID())
      .send(payload)
    expect(stale.status).toBe(409)
    expect(stale.body.error.code).toBe('LEGAL_AGREEMENT_STALE')
  })
})

describe('idempotency fingerprint canonicalization', () => {
  it('treats missing and empty agreementVersions as identical, and is key-order insensitive', () => {
    const base = { productId: 1, expectedPrice: 100 }
    // 复审 P2：{} 与未传必须同 digest——语义相同的重试不得误报 CONFLICT。
    expect(computeRequestDigest(base)).toBe(computeRequestDigest({ ...base, agreementVersions: {} }))
    // 空串值归一化剔除后亦等价于未传。
    expect(computeRequestDigest(base)).toBe(
      computeRequestDigest({ ...base, agreementVersions: { terms: '' } }),
    )
    // 实质内容变化必然改变指纹。
    expect(computeRequestDigest({ ...base, agreementVersions: { terms: '1.0' } })).not.toBe(
      computeRequestDigest(base),
    )
    // 键序无关。
    expect(
      computeRequestDigest({ ...base, agreementVersions: { terms: '1.0', refund: '1.0' } }),
    ).toBe(computeRequestDigest({ ...base, agreementVersions: { refund: '1.0', terms: '1.0' } }))
  })
})

describe('retention cron', () => {
  it('anonymizes expired ip/user-agent evidence and keeps fresh rows intact', async () => {
    const { user } = await createTestUser('legal-retention@test.local')
    const past = new Date(Date.now() - 1000)
    const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)

    const expired = await prisma.userAgreementConsent.create({
      data: {
        userId: user.id,
        document: 'terms',
        version: '1.0',
        contentHash: 'a'.repeat(64),
        ip: '203.0.113.10',
        userAgent: 'expired-agent',
        retentionUntil: past,
      },
    })
    const fresh = await prisma.userAgreementConsent.create({
      data: {
        userId: user.id,
        document: 'privacy',
        version: '1.0',
        contentHash: 'b'.repeat(64),
        ip: '203.0.113.11',
        userAgent: 'fresh-agent',
        retentionUntil: future,
      },
    })
    const neverExpires = await prisma.userAgreementConsent.create({
      data: {
        userId: user.id,
        document: 'about',
        version: '1.0',
        contentHash: 'c'.repeat(64),
        ip: '203.0.113.12',
        userAgent: 'unset-window-agent',
        retentionUntil: null,
      },
    })

    await __runLegalRetentionBatchForTests()

    const anonymized = await prisma.userAgreementConsent.findUniqueOrThrow({ where: { id: expired.id } })
    expect(anonymized.ip).toBeNull()
    expect(anonymized.userAgent).toBeNull()
    // 证据链不断：文档/版本/哈希/时间全部保留。
    expect(anonymized.document).toBe('terms')
    expect(anonymized.version).toBe('1.0')
    expect(anonymized.contentHash).toBe('a'.repeat(64))

    const untouched = await prisma.userAgreementConsent.findUniqueOrThrow({ where: { id: fresh.id } })
    expect(untouched.ip).toBe('203.0.113.11')
    expect(untouched.userAgent).toBe('fresh-agent')

    // retentionUntil = null 的行不在本任务职责范围（防御：不被误匿名化）。
    const unset = await prisma.userAgreementConsent.findUniqueOrThrow({ where: { id: neverExpires.id } })
    expect(unset.ip).toBe('203.0.113.12')

    // 幂等：第二轮不再有任何行被更新。
    await __runLegalRetentionBatchForTests()
    const stillNull = await prisma.userAgreementConsent.findUniqueOrThrow({ where: { id: expired.id } })
    expect(stillNull.ip).toBeNull()
  })
})
