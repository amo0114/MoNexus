import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, authHeader, createTestUser, loginAs } from '../../__tests__/helpers.js'
import { prisma } from '../../lib/prisma.js'
import { logger } from '../../lib/logger.js'
import * as cards from '../products/service.js'
import * as sponsored from '../merchandising/promotions/publicSponsored.js'
import * as editorial from '../merchandising/editorial/publicShelf.js'

beforeEach(() => sponsored.invalidateSponsoredCache())
afterEach(() => { vi.restoreAllMocks(); sponsored.invalidateSponsoredCache() })
const request = () => api.get('/api/storefront/candidates')

async function fixture() {
  const actor = await prisma.user.create({ data: { email: 'p2-actor@test.local', password: 'x', role: 'admin' } })
  const merchant = await prisma.merchant.create({ data: { userId: actor.id, name: '候选商家', status: 'active' } })
  const category = await prisma.productCategory.create({ data: {
    code: 'p2-primary', label: '主分类', normalizedLabel: '主分类', status: 'active', guestVisibility: 'public',
    createdByUserId: actor.id, updatedByUserId: actor.id,
  } })
  const other = await prisma.productCategory.create({ data: {
    code: 'p2-other', label: '其他分类', normalizedLabel: '其他分类', status: 'active', guestVisibility: 'public',
    createdByUserId: actor.id, updatedByUserId: actor.id,
  } })
  async function makeProduct(name: string, categoryId = category.id) {
    const product = await prisma.product.create({ data: {
      name, description: '商品卡片', type: '网络节点', categoryId, merchantId: merchant.id,
      price: 100, stock: 10, status: 'active', visibility: 'public',
      fixedContent: 'PRIVATE_DELIVERY_SENTINEL', richDescription: 'PRIVATE_RICH_SENTINEL',
    } })
    await prisma.productGuestEligibility.create({ data: { productId: product.id, decision: 'approved', reviewedRevision: 1 } })
    await prisma.offer.create({ data: {
      productId: product.id, name: '默认规格', isDefault: true, price: 100, stock: 10, stockMode: 'limited', status: 'active',
    } })
    return product
  }
  async function addEditorial(productId: number, placement = 'store_editorial', sortWeight = 1) {
    return prisma.editorialFeature.create({ data: {
      productId, placement, status: 'active', sortWeight, publicReason: '公开精选理由', internalReason: 'PRIVATE_EDITORIAL_SENTINEL',
      startsAt: new Date(Date.now() - 60_000), endsAt: new Date(Date.now() + 3_600_000), createdByUserId: actor.id,
    } })
  }
  async function addSponsored(productId: number, placement = 'store_home_sponsored') {
    const pkg = await prisma.promotionPackage.create({ data: {
      code: `${placement}-${productId}`, label: '推广套餐', placement, durationDays: 7, pricePoints: 100,
      description: '', createdByUserId: actor.id, updatedByUserId: actor.id,
    } })
    return prisma.promotionCampaign.create({ data: {
      productId, merchantId: merchant.id, packageId: pkg.id, packageCodeSnapshot: pkg.code,
      placementSnapshot: placement, durationDaysSnapshot: 7, pricePointsSnapshot: 100,
      requestIdempotencyKey: `candidate-${placement}-${productId}`, requestPayloadHash: 'a'.repeat(64), status: 'active',
      startsAt: new Date(Date.now() - 60_000), endsAt: new Date(Date.now() + 3_600_000),
    } })
  }
  return { actor, merchant, category, other, makeProduct, addEditorial, addSponsored }
}

describe('storefront candidate aggregation', () => {
  it('hydrates union IDs once and exposes only public cards and disclosure', async () => {
    const fx = await fixture(), product = await fx.makeProduct('候选商品')
    await fx.addSponsored(product.id)
    await fx.addEditorial(product.id)
    const batch = vi.spyOn(cards, 'getPublicProductCardsByIds')
    const res = await request().expect(200)
    expect(res.headers['cache-control']).toBe('private, no-store')
    expect(res.body).toMatchObject({ version: 1,
      sponsored: [{ productId: product.id, product: { id: product.id, name: product.name }, disclosure: { code: 'sponsored', label: '推广' } }],
      editorial: [{ productId: product.id, publicReason: '公开精选理由', label: '精选' }],
    })
    expect(Number.isNaN(Date.parse(res.body.generatedAt))).toBe(false)
    expect(batch).toHaveBeenCalledExactlyOnceWith([product.id], 'guest')
    for (const item of [...res.body.sponsored, ...res.body.editorial]) {
      for (const key of ['offers', 'fixedContent', 'richDescription', 'visibility', 'guestEligibility', 'publicContentRevision']) expect(item.product).not.toHaveProperty(key)
      for (const key of ['internalReason', 'chargedPoints', 'requestPayloadHash', 'reviewedByUserId']) expect(item).not.toHaveProperty(key)
    }
    expect(JSON.stringify(res.body)).not.toContain('PRIVATE_')
  })

  it('filters categories before taking six editorial slots and hides inaccessible/unknown codes', async () => {
    const fx = await fixture(), product = await fx.makeProduct('正确分类商品')
    await fx.addSponsored(product.id, 'category_sponsored')
    await fx.addEditorial(product.id, 'category_editorial')
    for (let i = 0; i < 7; i++) {
      const other = await fx.makeProduct(`其他分类商品${i}`, fx.other.id)
      await fx.addEditorial(other.id, 'category_editorial', 100 + i)
      if (i === 0) await fx.addSponsored(other.id, 'category_sponsored')
    }
    const res = await request().query({ categoryCode: fx.category.code }).expect(200)
    expect(res.body.sponsored.map((i: { productId: number }) => i.productId)).toEqual([product.id])
    expect(res.body.editorial.map((i: { productId: number }) => i.productId)).toEqual([product.id])
    expect((await request().query({ categoryCode: 'unknown-code' }).expect(200)).body).toMatchObject({ sponsored: [], editorial: [] })
    await prisma.productCategory.update({ where: { id: fx.category.id }, data: { guestVisibility: 'members_only' } })
    expect((await request().query({ categoryCode: fx.category.code }).expect(200)).body).toMatchObject({ sponsored: [], editorial: [] })
  })

  it('does not let invalid guest approvals consume the editorial limit', async () => {
    const fx = await fixture(), product = await fx.makeProduct('有效精选')
    await fx.addEditorial(product.id)
    for (let i = 0; i < 7; i++) {
      const hidden = await fx.makeProduct(`不可公开精选${i}`)
      await fx.addEditorial(hidden.id, 'store_editorial', 100 + i)
      if (i % 2 === 0) {
        await prisma.productGuestEligibility.delete({ where: { productId: hidden.id } })
      } else {
        await prisma.product.update({ where: { id: hidden.id }, data: { publicContentRevision: 2 } })
      }
    }
    const res = await request().expect(200)
    expect(res.body.editorial.map((item: { productId: number }) => item.productId)).toEqual([product.id])
  })

  it('rechecks guest/member visibility and merchant state even with warm sponsored IDs', async () => {
    const fx = await fixture(), product = await fx.makeProduct('仅会员可见候选')
    await fx.addSponsored(product.id)
    await fx.addEditorial(product.id)
    expect((await request().expect(200)).body.sponsored).toHaveLength(1)
    const viewer = await createTestUser('p2-viewer@test.local', 'password123')
    const { accessToken } = await loginAs(viewer.user.email, viewer.password)
    await prisma.productCategory.update({ where: { id: fx.category.id }, data: { guestVisibility: 'members_only' } })
    expect((await request().expect(200)).body).toMatchObject({ sponsored: [], editorial: [] })
    const member = await request().set(authHeader(accessToken)).expect(200)
    expect(member.body.sponsored).toHaveLength(1)
    expect(member.body.editorial).toHaveLength(1)
    await prisma.merchant.update({ where: { id: fx.merchant.id }, data: { status: 'suspended' } })
    expect((await request().set(authHeader(accessToken)).expect(200)).body).toMatchObject({ sponsored: [], editorial: [] })
  })

  it.each(['sponsored', 'editorial'] as const)('keeps the other source when %s fails', async source => {
    const fx = await fixture(), product = await fx.makeProduct('部分可用候选')
    await fx.addSponsored(product.id)
    await fx.addEditorial(product.id)
    const warning = vi.spyOn(logger, 'warn')
    if (source === 'sponsored') vi.spyOn(sponsored, 'listSponsoredItems').mockRejectedValueOnce(new Error('private provider error'))
    else vi.spyOn(editorial, 'listEditorialShelf').mockRejectedValueOnce(new Error('private provider error'))
    const res = await request().expect(200)
    expect(res.body[source]).toEqual([])
    expect(res.body[source === 'sponsored' ? 'editorial' : 'sponsored']).toHaveLength(1)
    expect(warning).toHaveBeenCalledWith(expect.objectContaining({ source, reason: 'candidate_selection_failed' }), expect.any(String))
    expect(JSON.stringify(res.body)).not.toContain('private provider error')
  })

  it('removes revoked editorial, outdated content, and inactive products on the next request', async () => {
    const fx = await fixture(), product = await fx.makeProduct('可撤销精选')
    const feature = await fx.addEditorial(product.id)
    expect((await request().expect(200)).body.editorial).toHaveLength(1)
    await prisma.editorialFeature.update({ where: { id: feature.id }, data: { status: 'revoked', revokedByUserId: fx.actor.id } })
    expect((await request().expect(200)).body.editorial).toEqual([])
    await prisma.editorialFeature.update({ where: { id: feature.id }, data: { status: 'active' } })
    await prisma.product.update({ where: { id: product.id }, data: { publicContentRevision: 2 } })
    expect((await request().expect(200)).body.editorial).toEqual([])
    await prisma.productGuestEligibility.update({ where: { productId: product.id }, data: { reviewedRevision: 2 } })
    await prisma.product.update({ where: { id: product.id }, data: { status: 'inactive' } })
    expect((await request().expect(200)).body.editorial).toEqual([])
  })

  it('bounds each source to six and rejects untrusted filters or invalid auth', async () => {
    const fx = await fixture()
    for (let i = 0; i < 7; i++) {
      const product = await fx.makeProduct(`候选${i}`)
      await fx.addSponsored(product.id)
      await fx.addEditorial(product.id)
    }
    const res = await request().expect(200)
    expect(res.body.sponsored).toHaveLength(6)
    expect(res.body.editorial).toHaveLength(6)
    await request().query({ categoryCode: 'INVALID' }).expect(400)
    await request().query({ audience: 'member' }).expect(400)
    await request().query({ placement: 'arbitrary' }).expect(400)
    await request().set('Authorization', 'Bearer invalid').expect(401)
  })
})
