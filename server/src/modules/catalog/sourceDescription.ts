import { createHash } from 'node:crypto'
import { prisma } from '../../lib/prisma.js'
import { badRequest, HttpError, notFound, type ErrorCode } from '../../lib/httpError.js'
import { invalidateProductPublicCache } from '../products/cache.js'
import { lockProductRow } from '../admin/productLifecycle.js'
import {
  fetchNormalizedFakaSource,
  type NormalizedFakaSource,
} from './externalCatalog.js'
import { CATALOG_ERROR_CODES } from './constants.js'

export type SourceDescriptionField = 'description' | 'richDescription'

export type SourceDescriptionApplyInput = {
  sourceHash: string
  descriptionHash: string
  expectedContentVersion: number
  fields: SourceDescriptionField[]
}

/** SHA-256(UTF-8 of sanitized HTML). Independent from sourceHash. Empty HTML hashes as "". */
export function hashSourceDescriptionHtml(html: string | null | undefined): string {
  return createHash('sha256').update(html ?? '', 'utf8').digest('hex')
}

export function sourceDescriptionObservation(
  source: Pick<NormalizedFakaSource, 'richDescription' | 'plainDescription'>,
  checkedAt = new Date(),
) {
  return {
    latestDescriptionHash: hashSourceDescriptionHtml(source.richDescription),
    latestDescriptionHtml: source.richDescription,
    latestDescriptionText: source.plainDescription,
    descriptionCheckedAt: checkedAt,
  }
}

async function loadXboardProduct(productId: number) {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    include: { externalCatalogLink: true },
  })
  if (!product) throw notFound('商品不存在')
  if (!product.externalCatalogLink) {
    throw badRequest('该商品不是 Xboard 导入商品')
  }
  const planId = Number(product.externalCatalogLink.externalProductId)
  if (!Number.isInteger(planId) || planId <= 0) {
    throw badRequest('外部套餐身份无效')
  }
  return { product, link: product.externalCatalogLink, planId }
}

function uniqueSourceDescriptionFields(fields: SourceDescriptionField[]): SourceDescriptionField[] {
  if (fields.length === 0 || new Set(fields).size !== fields.length) {
    throw badRequest('fields 必须非空且去重')
  }
  return fields
}

export async function previewProductSourceDescription(productId: number) {
  const { product, link, planId } = await loadXboardProduct(productId)
  const source = await fetchNormalizedFakaSource(planId)
  const descriptionHash = hashSourceDescriptionHtml(source.richDescription)
  return {
    sourceHash: source.sourceHash,
    descriptionHash,
    source: {
      description: source.plainDescription,
      richDescription: source.richDescription,
    },
    local: {
      description: product.description,
      richDescription: product.richDescription,
      contentVersion: product.contentVersion,
    },
    changedSinceAccepted: link.acceptedDescriptionHash == null
      ? null
      : link.acceptedDescriptionHash !== descriptionHash,
  }
}

export async function applyProductSourceDescription(
  adminUserId: number,
  productId: number,
  input: SourceDescriptionApplyInput,
) {
  const fields = uniqueSourceDescriptionFields(input.fields)
  const { planId } = await loadXboardProduct(productId)
  const source = await fetchNormalizedFakaSource(planId)
  const descriptionHash = hashSourceDescriptionHtml(source.richDescription)
  if (source.sourceHash !== input.sourceHash || descriptionHash !== input.descriptionHash) {
    throw new HttpError(
      409,
      CATALOG_ERROR_CODES.FAKA_SOURCE_CHANGED as ErrorCode,
      'Xboard 套餐已变化，请重新预览',
    )
  }

  const updated = await prisma.$transaction(async tx => {
    await lockProductRow(tx, productId)
    const current = await tx.product.findUnique({
      where: { id: productId },
      include: { externalCatalogLink: true },
    })
    if (!current) throw notFound('商品不存在')
    if (!current.externalCatalogLink) throw badRequest('该商品不是 Xboard 导入商品')
    if (current.contentVersion !== input.expectedContentVersion) {
      throw new HttpError(
        409,
        CATALOG_ERROR_CODES.PRODUCT_CONTENT_CHANGED as ErrorCode,
        '商品内容已更新，请刷新后重试',
      )
    }

    const data: { description?: string; richDescription?: string | null } = {}
    if (fields.includes('description')) data.description = source.plainDescription
    if (fields.includes('richDescription')) data.richDescription = source.richDescription

    const product = await tx.product.update({
      where: { id: productId },
      data: {
        ...data,
        contentVersion: { increment: 1 },
      },
      select: { id: true, contentVersion: true },
    })

    await tx.externalCatalogLink.update({
      where: { productId },
      data: {
        ...sourceDescriptionObservation(source),
        acceptedDescriptionHash: descriptionHash,
      },
    })
    await tx.adminLog.create({
      data: {
        adminUserId,
        action: '采纳Xboard源介绍',
        targetType: 'product',
        targetId: productId,
        detail: JSON.stringify({
          fields,
          sourceHash: source.sourceHash,
          descriptionHash,
        }),
      },
    })
    return product
  })

  await invalidateProductPublicCache(productId, { detail: true, list: true })
  return {
    id: updated.id,
    contentVersion: updated.contentVersion,
    appliedFields: fields,
    sourceHash: source.sourceHash,
    descriptionHash,
  }
}
