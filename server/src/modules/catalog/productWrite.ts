import type { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { HttpError, type ErrorCode } from '../../lib/httpError.js'
import { assertProductDeliveryConfiguration } from '../../lib/productCommercial.js'
import { resolveProductCategory } from './resolver.js'
import { CATALOG_ERROR_CODES } from './constants.js'
import { resolvePlatformPublicImage, type PlatformMediaRef, type ResolvedPlatformImage } from './platformMedia.js'
import { getProductTemplate } from './templates/registry.js'
import { evaluateTemplateFulfillment } from './templates/fulfillmentStrategy.js'
import { validateTemplateAttributes } from './templates/validate.js'
import { EMPTY_PRODUCT_DETAILS } from './templates/types.js'
import type { CreateProductV2Input } from './productV2Schema.js'
import { syncProductProjection } from '../../lib/offers.js'
import { invalidateProductPublicCache } from '../products/cache.js'

export type ProductWriteActor =
  | { kind: 'merchant'; merchantId: number }
  | { kind: 'admin'; adminUserId: number }

function templateInvalid(message: string, details?: Array<{ field: string; message: string }>): never {
  throw new HttpError(400, CATALOG_ERROR_CODES.PRODUCT_TEMPLATE_INVALID as ErrorCode, message, details)
}

export async function createProductFromV2(
  actor: ProductWriteActor,
  input: CreateProductV2Input,
) {
  const template = getProductTemplate(input.templateKey, input.templateVersion)
  if (!template) templateInvalid('未知的商品模板或版本')

  const productAttributes = validateTemplateAttributes({
    templateKey: input.templateKey,
    templateVersion: input.templateVersion,
    attributes: input.attributes,
    mode: 'draft',
    target: 'product',
    pathPrefix: '/attributes',
  })
  if (!productAttributes.ok) {
    templateInvalid('商品参数不合法', productAttributes.errors.map(error => ({
      field: error.path,
      message: error.message,
    })))
  }

  const resolvedImages: ResolvedPlatformImage[] = []
  for (const ref of input.images) {
    resolvedImages.push(await resolvePlatformPublicImage(ref as PlatformMediaRef))
  }

  const merchantId = actor.kind === 'merchant' ? actor.merchantId : null
  const product = await prisma.$transaction(async tx => {
    const { categoryId, type } = await resolveProductCategory({ categoryId: input.categoryId }, tx)
    const created = await tx.product.create({
      data: {
        name: input.name,
        description: input.description,
        richDescription: input.richDescription,
        categoryId,
        type,
        imageUrl: resolvedImages[0]?.canonicalUrl ?? null,
        images: resolvedImages.map(image => image.canonicalUrl),
        price: input.offers[0].price,
        originalPrice: input.offers[0].originalPrice,
        deliveryMode: input.offers[0].deliveryMode,
        stockMode: input.offers[0].stockMode,
        fixedContent: input.offers[0].fixedContent,
        fixedContentType: input.offers[0].fixedContentType === 'file' ? 'text' : input.offers[0].fixedContentType,
        purchaseForm: input.purchaseForm as unknown as Prisma.InputJsonValue,
        merchantId,
        status: 'draft',
        stock: 0,
        templateKey: input.templateKey,
        templateVersion: input.templateVersion,
        attributes: productAttributes.value as Prisma.InputJsonValue,
        details: (input.details ?? EMPTY_PRODUCT_DETAILS) as Prisma.InputJsonValue,
        visibility: input.visibility,
        contentVersion: 1,
      },
    })

    for (const [index, offerInput] of input.offers.entries()) {
      const offerAttributes = validateTemplateAttributes({
        templateKey: input.templateKey,
        templateVersion: input.templateVersion,
        attributes: offerInput.attributes,
        mode: 'draft',
        target: 'offer',
        pathPrefix: `/offers/${index}/attributes`,
      })
      if (!offerAttributes.ok) {
        templateInvalid('套餐参数不合法', offerAttributes.errors.map(error => ({
          field: error.path,
          message: error.message,
        })))
      }
      if (!(offerInput.fixedContentType === 'file' && offerInput.fixedFileId == null)
        && !(offerInput.deliveryMode === 'instant_fixed' && offerInput.fixedContent == null && offerInput.fixedContentType !== 'file')) {
        assertProductDeliveryConfiguration({
          deliveryMode: offerInput.deliveryMode,
          stockMode: offerInput.stockMode,
          effectiveStock: 0,
          fixedContent: offerInput.fixedContent ?? undefined,
          fixedContentType: offerInput.fixedContentType,
          fixedFileId: offerInput.fixedFileId,
          allowFileForm: true,
        })
      }
      const fulfillment = evaluateTemplateFulfillment({
        template,
        productAttributes: productAttributes.value,
        offer: {
          deliveryMode: offerInput.deliveryMode,
          stockMode: offerInput.stockMode,
          fixedContentType: offerInput.fixedContentType,
          fixedContent: offerInput.fixedContent,
          fixedFileId: offerInput.fixedFileId,
          deliveryFields: offerInput.deliveryFields,
          autoProvision: offerInput.autoProvision,
          externalIntegration: null,
          fixedStructuredContent: offerInput.fixedStructuredContent,
        },
        mode: 'draft',
        purchaseForm: input.purchaseForm,
      })
      if (!fulfillment.ok) {
        throw new HttpError(
          400,
          CATALOG_ERROR_CODES.PRODUCT_TEMPLATE_INVALID as ErrorCode,
          fulfillment.message,
        )
      }
      if (offerInput.autoProvision && actor.kind !== 'merchant') {
        throw new HttpError(400, 'BAD_REQUEST', '平台商品不能开启商家自动开通')
      }
      await tx.offer.create({
        data: {
          productId: created.id,
          name: offerInput.name,
          price: offerInput.price,
          originalPrice: offerInput.originalPrice,
          isDefault: index === 0,
          sortOrder: index,
          status: 'active',
          deliveryMode: offerInput.deliveryMode,
          stockMode: offerInput.stockMode,
          stock: 0,
          fixedContent: offerInput.fixedContent,
          fixedContentType: offerInput.fixedContentType,
          fixedFileId: offerInput.fixedFileId,
          validityDays: offerInput.validityDays,
          ...(offerInput.deliveryFields != null
            ? { deliveryFields: offerInput.deliveryFields as Prisma.InputJsonValue }
            : {}),
          autoProvision: offerInput.autoProvision,
          attributes: offerAttributes.value as Prisma.InputJsonValue,
          ...(offerInput.fixedStructuredContent != null
            ? { fixedStructuredContent: offerInput.fixedStructuredContent as Prisma.InputJsonValue }
            : {}),
        },
      })
    }
    await syncProductProjection(tx, created.id)
    return tx.product.findUniqueOrThrow({
      where: { id: created.id },
      include: { offers: { orderBy: { sortOrder: 'asc' }, select: { id: true, name: true, isDefault: true } } },
    })
  })

  await invalidateProductPublicCache(product.id, { list: true })
  return {
    id: product.id,
    status: product.status,
    contentVersion: product.contentVersion,
    offers: product.offers.map(offer => ({ id: offer.id, name: offer.name, isDefault: offer.isDefault })),
    nextStep: 'availability' as const,
  }
}
