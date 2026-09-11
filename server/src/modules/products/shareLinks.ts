import { randomUUID } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { config } from '../../config/index.js'
import { HttpError, notFound, type ErrorCode } from '../../lib/httpError.js'
import {
  getShortlinkClient,
  type ShortlinkClient,
} from '../../lib/shortlinkClient.js'
import { CATALOG_ERROR_CODES } from '../catalog/constants.js'
import {
  assertPublicProductAccess,
  type ProductAudience,
  type PublicProductAccessRow,
} from './visibility.js'

export const SHARE_LINK_LEASE_MS = 30_000

export type ProductShareLinkResponse = {
  productId: number
  url: string
  reused: boolean
}

type ClaimResult =
  | { kind: 'ready'; url: string }
  | { kind: 'claimed'; attemptToken: string; targetUrl: string }

const productAccessSelect = {
  status: true,
  archivedAt: true,
  visibility: true,
  merchantId: true,
  merchant: { select: { status: true } },
} satisfies Prisma.ProductSelect

let clientForTests: ShortlinkClient | null | undefined

export function __setShortlinkClientForTests(client: ShortlinkClient | null | undefined): void {
  clientForTests = client
}

function shareUnavailable(): HttpError {
  return new HttpError(
    503,
    CATALOG_ERROR_CODES.SHARE_LINK_UNAVAILABLE as ErrorCode,
    '分享暂未开放',
  )
}

function shareCreating(): HttpError {
  return new HttpError(
    409,
    CATALOG_ERROR_CODES.SHARE_LINK_CREATING as ErrorCode,
    '链接正在准备，请稍后重试',
  )
}

function canonicalProductUrl(productId: number): string {
  const base = (config.appBaseUrl || config.frontendOrigin).replace(/\/$/, '')
  return `${base}/product/${productId}`
}

function resolveClient(): ShortlinkClient | null {
  if (clientForTests !== undefined) return clientForTests
  return getShortlinkClient()
}

function isUniqueConflict(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'
}

function leaseUnexpired(leaseUntil: Date | null, now: Date): boolean {
  return leaseUntil != null && leaseUntil.getTime() > now.getTime()
}

async function loadProductAccess(productId: number) {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: productAccessSelect,
  })
  if (!product) throw notFound('商品暂不可用')
  return product
}

function assertAudienceAccess(product: PublicProductAccessRow, audience: ProductAudience): void {
  assertPublicProductAccess(product, audience)
}

async function claimAttempt(productId: number, audience: ProductAudience): Promise<ClaimResult> {
  const targetUrl = canonicalProductUrl(productId)
  return prisma.$transaction(async tx => {
    const locked = await tx.$queryRaw<Array<{ id: number }>>`
      SELECT "id" FROM "Product" WHERE "id" = ${productId} FOR UPDATE
    `
    if (locked.length === 0) throw notFound('商品暂不可用')

    const product = await tx.product.findUnique({
      where: { id: productId },
      select: productAccessSelect,
    })
    if (!product) throw notFound('商品暂不可用')
    assertAudienceAccess(product, audience)

    const now = new Date()
    const attemptToken = randomUUID()
    const leaseUntil = new Date(now.getTime() + SHARE_LINK_LEASE_MS)

    let existing = await tx.productShareLink.findUnique({ where: { productId } })
    if (!existing) {
      try {
        await tx.productShareLink.create({
          data: {
            productId,
            status: 'creating',
            attemptToken,
            leaseUntil,
            url: null,
            targetUrl,
          },
        })
        return { kind: 'claimed', attemptToken, targetUrl }
      } catch (err) {
        if (!isUniqueConflict(err)) throw err
        existing = await tx.productShareLink.findUnique({ where: { productId } })
        if (!existing) throw shareUnavailable()
      }
    }

    if (!existing) throw shareUnavailable()
    if (existing.status === 'ready' && existing.url) {
      return { kind: 'ready', url: existing.url }
    }
    if (existing.status === 'creating' && leaseUnexpired(existing.leaseUntil, now)) {
      throw shareCreating()
    }

    const cas = await tx.productShareLink.updateMany({
      where: {
        productId,
        OR: [
          { status: 'failed' },
          { status: 'creating', leaseUntil: { lte: now } },
        ],
      },
      data: {
        status: 'creating',
        attemptToken,
        leaseUntil,
        url: null,
        targetUrl,
      },
    })
    if (cas.count !== 1) throw shareCreating()
    return { kind: 'claimed', attemptToken, targetUrl }
  })
}

async function casReady(
  productId: number,
  attemptToken: string,
  url: string,
  targetUrl: string,
): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ productId: number }>>`
    UPDATE "ProductShareLink"
    SET
      "status" = 'ready',
      "url" = ${url},
      "targetUrl" = ${targetUrl},
      "leaseUntil" = NULL,
      "updatedAt" = NOW()
    WHERE "productId" = ${productId}
      AND "attemptToken" = ${attemptToken}::uuid
      AND "status" = 'creating'
    RETURNING "productId"
  `
  return rows.length === 1
}

async function casFailed(productId: number, attemptToken: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "ProductShareLink"
    SET
      "status" = 'failed',
      "leaseUntil" = NULL,
      "updatedAt" = NOW()
    WHERE "productId" = ${productId}
      AND "attemptToken" = ${attemptToken}::uuid
      AND "status" = 'creating'
  `
}

async function respondReady(
  productId: number,
  url: string,
  reused: boolean,
  audience: ProductAudience,
): Promise<ProductShareLinkResponse> {
  const product = await loadProductAccess(productId)
  assertAudienceAccess(product, audience)
  return { productId, url, reused }
}

export async function createProductShareLink(
  productId: number,
  audience: ProductAudience,
): Promise<ProductShareLinkResponse> {
  const client = resolveClient()
  if (!client) throw shareUnavailable()

  const product = await loadProductAccess(productId)
  assertAudienceAccess(product, audience)

  const claim = await claimAttempt(productId, audience)
  if (claim.kind === 'ready') {
    return respondReady(productId, claim.url, true, audience)
  }

  let created: { url: string }
  try {
    created = await client.createShortLink(claim.targetUrl)
  } catch (err) {
    await casFailed(productId, claim.attemptToken)
    if (err instanceof HttpError) throw err
    throw shareUnavailable()
  }

  const committed = await casReady(productId, claim.attemptToken, created.url, claim.targetUrl)
  if (!committed) {
    const current = await prisma.productShareLink.findUnique({ where: { productId } })
    if (current?.status === 'ready' && current.url) {
      return respondReady(productId, current.url, true, audience)
    }
    if (current?.status === 'creating' && leaseUnexpired(current.leaseUntil, new Date())) {
      throw shareCreating()
    }
    throw shareUnavailable()
  }

  return respondReady(productId, created.url, false, audience)
}
