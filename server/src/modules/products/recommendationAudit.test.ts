import { describe, expect, it } from 'vitest'
import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { createTestMerchant } from '../../__tests__/helpers.js'
import { getActiveCategoryIdByLabel } from '../../__tests__/catalogFixture.js'
import { auditRecommendationData, renderRecommendationAuditMarkdown } from './recommendationAudit.js'

async function makeProduct(data: {
  name: string
  categoryId: number
  merchantId?: number | null
  serviceName?: unknown
  legacy?: boolean
  archived?: boolean
}) {
  const product = await prisma.product.create({
    data: {
      name: data.name, type: '邀请码', categoryId: data.categoryId, merchantId: data.merchantId ?? null,
      price: 100, stock: 0, status: 'active', visibility: 'members_only', deliveryMode: 'manual_service',
      stockMode: 'unlimited', archivedAt: data.archived ? new Date() : null,
      templateKey: data.legacy ? null : 'redemption_code', templateVersion: data.legacy ? null : 1,
      attributes: (data.serviceName === undefined ? {} : { serviceName: data.serviceName }) as Prisma.InputJsonValue,
    },
  })
  await prisma.offer.create({
    data: {
      productId: product.id, name: '默认', isDefault: true, price: 100, stock: 0,
      deliveryMode: 'manual_service', stockMode: 'unlimited',
    },
  })
  return product
}

describe('auditRecommendationData', () => {
  it('reports completeness, name spellings, legacy share, weak same-seller placeholders and sources', async () => {
    const categoryId = await getActiveCategoryIdByLabel('邀请码')
    const { merchant: m, user } = await createTestMerchant('audit-m@test.local', 'pass123', { status: 'active', name: '店M' })
    const { merchant: n } = await createTestMerchant('audit-n@test.local', 'pass123', { status: 'active', name: '店N' })

    const base = await makeProduct({ name: '基准', categoryId, merchantId: m.id, serviceName: 'Steam' })
    await makeProduct({ name: '同店强', categoryId, merchantId: m.id, serviceName: ' steam ' })
    const weak = await makeProduct({ name: '同店旧数据', categoryId, merchantId: m.id, legacy: true })
    for (let i = 0; i < 6; i++) await makeProduct({ name: `跨店强${i}`, categoryId, merchantId: n.id, serviceName: 'STEAM' })
    await makeProduct({ name: '钱包', categoryId, merchantId: n.id, serviceName: 'Steam Wallet' })
    await makeProduct({ name: '奈飞A', categoryId, merchantId: n.id, serviceName: 'Net-flix' })
    await makeProduct({ name: '奈飞B', categoryId, merchantId: n.id, serviceName: 'netflix' })
    await makeProduct({ name: '缺主值', categoryId, merchantId: n.id, serviceName: 42 })
    await makeProduct({ name: '已归档', categoryId, merchantId: n.id, serviceName: 'Steam', archived: true })
    const imported = await makeProduct({ name: '某节点 月付', categoryId, serviceName: 'Steam' })
    await prisma.externalCatalogLink.create({
      data: {
        provider: 'faka_bridge', externalProductId: '7', productId: imported.id, sourceHash: 'h', sourceSnapshot: {},
        idempotencyKey: 'audit-import-1', requestHash: 'a'.repeat(64), importedByUserId: user.id,
      },
    })

    const report = await auditRecommendationData({ sampleLimit: 50, now: new Date('2026-10-14T00:00:00Z') })

    // 15 created, the archived one is out of scope.
    expect(report.scope).toMatchObject({ products: 14, withActiveOffer: 14 })
    const rc = report.completeness.find(row => row.template === 'redemption_code@1')!
    expect(rc).toMatchObject({ products: 13, primaryKey: 'serviceName', primaryPresent: 12, primaryMissing: 1 })
    expect(report.legacyTemplates).toMatchObject({ products: 14, legacyOrUnknown: 1 })

    const names = report.names.serviceName
    const steam = names.values.find(value => value.normalized === 'steam')!
    expect(steam.count).toBe(9)
    expect(steam.spellings.map(s => s.raw).sort()).toEqual([' steam ', 'STEAM', 'Steam'])
    expect(names.suspectedSynonyms.looseNormalization.map(group => [...group.values].sort()))
      .toContainEqual(['net-flix', 'netflix'])
    expect(names.suspectedSynonyms.containment).toContainEqual({ shorter: 'steam', longer: 'steam wallet', status: '待确认' })

    const rec = report.recommendations
    expect(rec.bases).toBe(14)
    const sample = (rec.weakSameSellerPlaceholder.samples as Array<{ productId: number; weakSameSeller: Array<{ productId: number }> }>)
      .find(entry => entry.productId === base.id)!
    expect(sample.weakSameSeller.map(slot => slot.productId)).toEqual([weak.id])

    expect(report.sources.externalImport).toEqual({ products: 1, byProvider: { faka_bridge: 1 } })
    expect(report.sources.importedNamesWithOfferTerms.samples).toEqual([
      { productId: imported.id, name: '某节点 月付', serviceName: 'Steam', status: '待确认' },
    ])
    expect(report.sources.aiCreation.status).toBe('无法区分')

    const markdown = renderRecommendationAuditMarkdown(report)
    expect(markdown).toContain('## 5. 推荐位占用与不足')
    expect(markdown).toContain('AI 创建来源：无法区分')
  })

  it('compares C0/C1/C2 over the full scope with member and guest denominators and untruncated details', async () => {
    const categoryId = await getActiveCategoryIdByLabel('邀请码')
    const known = await makeProduct({ name: '已知', categoryId, serviceName: 'Steam' })
    const peer = await makeProduct({ name: '同主值', categoryId, serviceName: 'steam' })
    const legacy = await makeProduct({ name: '旧数据', categoryId, legacy: true })
    await prisma.product.update({ where: { id: legacy.id }, data: { visibility: 'public' } })
    await prisma.product.update({ where: { id: known.id }, data: { visibility: 'public' } })

    const report = await auditRecommendationData({ sampleLimit: 1, compare: true })
    const cmp = report.comparison!
    expect(cmp.audiences.member.bases).toBe(3)
    // Guests only open public products: the members_only peer is never a guest base.
    expect(cmp.audiences.guest.bases).toBe(2)
    expect(cmp.details).toHaveLength(5)

    const memberKnown = cmp.details.find(detail => detail.audience === 'member' && detail.sourceId === known.id)!
    expect(memberKnown.rules.C0.map(slot => slot.id)).toEqual([peer.id, legacy.id])
    expect(memberKnown.changes.C1).toEqual({ removed: [legacy.id], added: [], moved: [] })
    const memberLegacy = cmp.details.find(detail => detail.audience === 'member' && detail.sourceId === legacy.id)!
    expect(memberLegacy.changes.C1.removed).toEqual([])
    expect(memberLegacy.rules.C2).toEqual([])
    expect(cmp.audiences.member.changes.C2.basesLosingAllCandidates).toBe(1)
    // Guest candidates exclude members_only products too.
    const guestKnown = cmp.details.find(detail => detail.audience === 'guest' && detail.sourceId === known.id)!
    expect(guestKnown.rules.C0.map(slot => slot.id)).toEqual([legacy.id])

    // Samples are capped; totals and details are not.
    expect(cmp.changedSamples.C1).toMatchObject({ shown: 1, truncated: true })
    expect(cmp.changedSamples.C1.total).toBeGreaterThan(1)
    const markdown = renderRecommendationAuditMarkdown(report)
    expect(markdown).toContain('## 7. 离线准入比较')
    expect(markdown).toContain('本指标是可售过滤前的前六候选')
    expect(markdown).not.toContain('可售过滤只会进一步减少')
    expect((await auditRecommendationData({ sampleLimit: 1 })).comparison).toBeUndefined()
  })
})
