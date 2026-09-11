import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { prisma } from '../../lib/prisma.js'
import { createTestProduct } from '../../__tests__/helpers.js'
import { CATALOG_ERROR_CODES } from '../catalog/constants.js'
import { config } from '../../config/index.js'
import {
  __setShortlinkClientForTests,
  createProductShareLink,
} from './shareLinks.js'

const PUBLIC_URL = 'https://s.example/Ab3x9'
const TAKEOVER_URL = 'https://s.example/NewTok'
const LATE_URL = 'https://s.example/OldTok'

function canonicalUrl(productId: number): string {
  return `${config.appBaseUrl.replace(/\/$/, '')}/product/${productId}`
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 15))
  }
  throw new Error('waitFor timeout')
}

afterEach(() => {
  __setShortlinkClientForTests(undefined)
})

describe('createProductShareLink', () => {
  it('returns SHARE_LINK_UNAVAILABLE when sharing is unconfigured', async () => {
    const product = await createTestProduct('未配置分享', 50, 1, ['SHARE-UNCFG'])
    __setShortlinkClientForTests(null)
    await expect(createProductShareLink(product.id, 'guest')).rejects.toMatchObject({
      status: 503,
      code: CATALOG_ERROR_CODES.SHARE_LINK_UNAVAILABLE,
    })
    expect(await prisma.productShareLink.count({ where: { productId: product.id } })).toBe(0)
  })

  it('lets an active sold-out product share and reuses a ready row', async () => {
    const product = await createTestProduct('售罄可分享', 80, 0, [])
    let creates = 0
    __setShortlinkClientForTests({
      async createShortLink(originUrl) {
        creates += 1
        expect(originUrl).toBe(canonicalUrl(product.id))
        return { url: PUBLIC_URL }
      },
    })

    const first = await createProductShareLink(product.id, 'guest')
    expect(first).toEqual({ productId: product.id, url: PUBLIC_URL, reused: false })
    const second = await createProductShareLink(product.id, 'guest')
    expect(second).toEqual({ productId: product.id, url: PUBLIC_URL, reused: true })
    expect(creates).toBe(1)
  })

  it('returns 404 for inactive or archived products and 403 for members_only guests', async () => {
    const inactive = await createTestProduct('下架不可分享', 40, 1, ['SHARE-IN'])
    await prisma.product.update({ where: { id: inactive.id }, data: { status: 'inactive' } })
    __setShortlinkClientForTests({
      createShortLink: async () => ({ url: PUBLIC_URL }),
    })
    await expect(createProductShareLink(inactive.id, 'guest')).rejects.toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
    })

    const locked = await createTestProduct('会员分享', 40, 1, ['SHARE-LOCK'])
    await prisma.product.update({ where: { id: locked.id }, data: { visibility: 'members_only' } })
    await expect(createProductShareLink(locked.id, 'guest')).rejects.toMatchObject({
      status: 403,
      code: CATALOG_ERROR_CODES.PRODUCT_LOGIN_REQUIRED,
    })
    const member = await createProductShareLink(locked.id, 'member')
    expect(member.url).toBe(PUBLIC_URL)
  })

  it('stores a ready URL but does not return it after the product becomes members_only for a guest', async () => {
    const product = await createTestProduct('分享后转会员', 40, 1, ['SHARE-FLIP'])
    __setShortlinkClientForTests({
      async createShortLink() {
        await prisma.product.update({
          where: { id: product.id },
          data: { visibility: 'members_only' },
        })
        return { url: PUBLIC_URL }
      },
    })

    await expect(createProductShareLink(product.id, 'guest')).rejects.toMatchObject({
      status: 403,
      code: CATALOG_ERROR_CODES.PRODUCT_LOGIN_REQUIRED,
    })
    const row = await prisma.productShareLink.findUnique({ where: { productId: product.id } })
    expect(row).toMatchObject({ status: 'ready', url: PUBLIC_URL })
  })

  it('writes failed and returns SHARE_LINK_UNAVAILABLE on remote failure', async () => {
    const product = await createTestProduct('远端失败', 40, 1, ['SHARE-FAIL'])
    __setShortlinkClientForTests({
      async createShortLink() {
        throw new Error('remote down')
      },
    })
    await expect(createProductShareLink(product.id, 'guest')).rejects.toMatchObject({
      status: 503,
      code: CATALOG_ERROR_CODES.SHARE_LINK_UNAVAILABLE,
    })
    const row = await prisma.productShareLink.findUnique({ where: { productId: product.id } })
    expect(row?.status).toBe('failed')
    expect(row?.url).toBeNull()
  })

  it('lets only one concurrent claim become the canonical winner', async () => {
    const product = await createTestProduct('并发短链', 40, 1, ['SHARE-RACE'])
    let creates = 0
    let releaseRemote: () => void = () => {}
    const remoteGate = new Promise<void>(resolve => {
      releaseRemote = resolve
    })
    __setShortlinkClientForTests({
      async createShortLink() {
        creates += 1
        await remoteGate
        return { url: PUBLIC_URL }
      },
    })

    const first = createProductShareLink(product.id, 'guest')
    await waitFor(async () => {
      const row = await prisma.productShareLink.findUnique({ where: { productId: product.id } })
      return row?.status === 'creating'
    })
    const second = await createProductShareLink(product.id, 'guest').catch(err => err)
    expect(second).toMatchObject({
      status: 409,
      code: CATALOG_ERROR_CODES.SHARE_LINK_CREATING,
    })
    expect(creates).toBe(1)
    releaseRemote()
    await expect(first).resolves.toEqual({ productId: product.id, url: PUBLIC_URL, reused: false })
    expect(await prisma.productShareLink.findUnique({ where: { productId: product.id } })).toMatchObject({
      status: 'ready',
      url: PUBLIC_URL,
    })
  })

  it('lets an expired lease be taken over', async () => {
    const product = await createTestProduct('过期租约', 40, 1, ['SHARE-EXP'])
    await prisma.productShareLink.create({
      data: {
        productId: product.id,
        status: 'creating',
        attemptToken: randomUUID(),
        leaseUntil: new Date(Date.now() - 1_000),
        targetUrl: canonicalUrl(product.id),
      },
    })
    __setShortlinkClientForTests({
      createShortLink: async () => ({ url: TAKEOVER_URL }),
    })

    const result = await createProductShareLink(product.id, 'guest')
    expect(result).toEqual({ productId: product.id, url: TAKEOVER_URL, reused: false })
    expect(await prisma.productShareLink.findUnique({ where: { productId: product.id } })).toMatchObject({
      status: 'ready',
      url: TAKEOVER_URL,
    })
  })

  it('does not let a late CAS overwrite a newer attempt', async () => {
    const product = await createTestProduct('迟到CAS', 40, 1, ['SHARE-LATE'])
    let creates = 0
    let releaseFirst: () => void = () => {}
    const firstGate = new Promise<void>(resolve => {
      releaseFirst = resolve
    })
    __setShortlinkClientForTests({
      async createShortLink() {
        creates += 1
        if (creates === 1) {
          await firstGate
          return { url: LATE_URL }
        }
        return { url: TAKEOVER_URL }
      },
    })

    const first = createProductShareLink(product.id, 'guest')
    await waitFor(async () => {
      const row = await prisma.productShareLink.findUnique({ where: { productId: product.id } })
      return row?.status === 'creating'
    })
    await prisma.productShareLink.update({
      where: { productId: product.id },
      data: { leaseUntil: new Date(Date.now() - 1_000) },
    })
    const second = await createProductShareLink(product.id, 'guest')
    expect(second).toEqual({ productId: product.id, url: TAKEOVER_URL, reused: false })
    releaseFirst()
    const firstResult = await first
    expect(firstResult.url).toBe(TAKEOVER_URL)
    expect(await prisma.productShareLink.findUnique({ where: { productId: product.id } })).toMatchObject({
      status: 'ready',
      url: TAKEOVER_URL,
    })
    expect(creates).toBe(2)
  })
})
