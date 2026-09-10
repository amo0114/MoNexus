import type { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { HttpError, notFound, type ErrorCode, type ErrorDetail } from '../../lib/httpError.js'
import { assertProductDeliveryConfiguration } from '../../lib/productCommercial.js'
import { resolveProductCategory } from './resolver.js'
import { CATALOG_ERROR_CODES } from './constants.js'
import {
  MediaRefResolutionError,
  resolvePlatformPublicImage,
  type PlatformMediaRef,
  type ResolvedPlatformImage,
} from './platformMedia.js'
import { getProductTemplate } from './templates/registry.js'
import { evaluateTemplateFulfillment } from './templates/fulfillmentStrategy.js'
import { validateTemplateAttributes } from './templates/validate.js'
import { EMPTY_PRODUCT_DETAILS, type FulfillmentOfferInput, type TemplateAttributes, type TemplateKey } from './templates/types.js'
import type { CreateProductV2Input, DescriptionImageRef, PatchProductContentInput } from './productV2Schema.js'
import { computeOfferCheckoutVersion, syncProductProjection } from '../../lib/offers.js'
import { invalidateProductPublicCache } from '../products/cache.js'
import { listPersistedDescriptionImages, sanitizeProductRichContent } from './contentSanitizer.js'
import { assertOwnedActiveDeliveryFile } from './deliveryFileOwnership.js'
import { checkProductReadiness, type ProductReadinessResult } from './publicationReadiness.js'
import { canonicalFixedStructuredText, normalizeFixedStructuredContent } from './structuredFixedContent.js'
import { lockProductRow } from '../admin/productLifecycle.js'

export type ProductWriteActor =
  | { kind: 'merchant'; merchantId: number }
  | { kind: 'admin'; adminUserId: number }

function templateInvalid(message: string, details?: Array<{ field: string; message: string }>): never {
  throw new HttpError(400, CATALOG_ERROR_CODES.PRODUCT_TEMPLATE_INVALID as ErrorCode, message, details)
}

function templateLocked(message: string): never {
  throw new HttpError(400, CATALOG_ERROR_CODES.PRODUCT_TEMPLATE_LOCKED as ErrorCode, message)
}

function notReadyError(readiness: ProductReadinessResult): never {
  throw new HttpError(
    422,
    CATALOG_ERROR_CODES.PRODUCT_NOT_READY as ErrorCode,
    '商品尚未满足发布条件',
    readiness.details as unknown as ErrorDetail[],
  )
}

function resolveWritableTemplate(key: string | null | undefined, version: number | null | undefined) {
  if (key == null || version == null) return null
  return getProductTemplate(key as TemplateKey, version)
}

function asTemplateAttributes(value: unknown): TemplateAttributes {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return {}
  const record: TemplateAttributes = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (
      typeof entry === 'string'
      || typeof entry === 'number'
      || typeof entry === 'boolean'
      || (Array.isArray(entry) && entry.every(item => typeof item === 'string'))
    ) {
      record[key] = entry
    }
  }
  return record
}

function asPurchaseForm(value: unknown): Array<{ type?: string; required?: boolean }> {
  return Array.isArray(value) ? value as Array<{ type?: string; required?: boolean }> : []
}

function offerToFulfillmentInput(offer: {
  deliveryMode: string
  stockMode: string
  fixedContentType: string
  fixedContent: string | null
  fixedFileId: number | null
  deliveryFields: unknown
  autoProvision: boolean
  externalIntegration: string | null
  fixedStructuredContent: unknown
}): FulfillmentOfferInput {
  return {
    deliveryMode: offer.deliveryMode,
    stockMode: offer.stockMode,
    fixedContentType: offer.fixedContentType,
    fixedContent: offer.fixedContent,
    fixedFileId: offer.fixedFileId,
    deliveryFields: offer.deliveryFields,
    autoProvision: offer.autoProvision,
    externalIntegration: offer.externalIntegration,
    fixedStructuredContent: offer.fixedStructuredContent,
  }
}

async function resolveRichDescription(
  html: string | null | undefined,
  images: DescriptionImageRef[] | undefined,
): Promise<string | null> {
  if (typeof html !== 'string' || html.trim() === '') return null
  const allowedCanonicalSrcs: string[] = []
  const srcRewrites = new Map<string, string>()
  for (const image of images ?? []) {
    try {
      const resolved = await resolvePlatformPublicImage(image.ref as PlatformMediaRef)
      allowedCanonicalSrcs.push(resolved.canonicalUrl)
      srcRewrites.set(image.src, resolved.canonicalUrl)
    } catch (err) {
      if (err instanceof MediaRefResolutionError) continue
      throw err
    }
  }
  return sanitizeProductRichContent(html, allowedCanonicalSrcs, srcRewrites)
}

async function assertTemplateAssignable(
  tx: Prisma.TransactionClient,
  productId: number,
  current: { status: string; purchaseForm: Prisma.JsonValue },
  template: NonNullable<ReturnType<typeof resolveWritableTemplate>>,
  productAttributes: TemplateAttributes,
  purchaseForm: unknown,
): Promise<void> {
  if (current.status === 'active') {
    templateLocked('在售商品不能补齐形态')
  }
  if (current.status !== 'draft' && current.status !== 'inactive') {
    templateLocked('在售商品不能补齐形态')
  }

  const offers = await tx.offer.findMany({
    where: { productId },
    select: {
      id: true,
      name: true,
      deliveryMode: true,
      stockMode: true,
      fixedContentType: true,
      fixedContent: true,
      fixedFileId: true,
      deliveryFields: true,
      autoProvision: true,
      externalIntegration: true,
      fixedStructuredContent: true,
    },
  })
  const offerIds = offers.map(offer => offer.id)
  if (offerIds.length > 0) {
    const openTasks = await tx.fakaBridgeTask.count({
      where: {
        order: { offerId: { in: offerIds } },
        OR: [
          { status: { in: ['pending', 'needs_reconcile'] } },
          { revokeStatus: 'pending' },
        ],
      },
    })
    if (openTasks > 0) {
      throw new HttpError(
        400,
        CATALOG_ERROR_CODES.FAKA_OPEN_TASK as ErrorCode,
        '存在未完成的外部开通任务，无法补齐商品形态',
      )
    }
  }

  const nextPurchaseForm = asPurchaseForm(purchaseForm ?? current.purchaseForm)
  const incompatible: ErrorDetail[] = []
  for (const offer of offers) {
    const fulfillment = evaluateTemplateFulfillment({
      template,
      productAttributes,
      offer: offerToFulfillmentInput(offer),
      mode: 'draft',
      purchaseForm: nextPurchaseForm,
    })
    if (!fulfillment.ok) {
      incompatible.push({
        field: `/offers/${offer.id}`,
        message: `套餐「${offer.name}」与所选形态不相容`,
      })
    }
  }
  if (incompatible.length > 0) {
    templateInvalid('现有套餐与所选形态不相容', incompatible)
  }
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
  const richDescription = input.richDescription === ''
    ? null
    : await resolveRichDescription(input.richDescription, input.descriptionImages)
  const product = await prisma.$transaction(async tx => {
    const { categoryId, type } = await resolveProductCategory({ categoryId: input.categoryId }, tx)
    const created = await tx.product.create({
      data: {
        name: input.name,
        description: input.description,
        richDescription,
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
      const structured = offerInput.fixedStructuredContent != null
        ? normalizeFixedStructuredContent(offerInput.fixedStructuredContent)
        : null
      if (structured && offerInput.fixedContent != null) {
        throw new HttpError(400, 'BAD_REQUEST', '结构化固定内容与 fixedContent 不能同时提交')
      }
      if (offerInput.fixedFileId != null) {
        await assertOwnedActiveDeliveryFile(tx, actor, offerInput.fixedFileId)
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
          fixedContent: structured ? canonicalFixedStructuredText(structured) : offerInput.fixedContent,
          fixedContentType: offerInput.fixedContentType,
          fixedFileId: offerInput.fixedFileId,
          validityDays: offerInput.validityDays,
          ...(offerInput.deliveryFields != null
            ? { deliveryFields: offerInput.deliveryFields as Prisma.InputJsonValue }
            : {}),
          autoProvision: offerInput.autoProvision,
          attributes: offerAttributes.value as Prisma.InputJsonValue,
          ...(structured
            ? { fixedStructuredContent: structured as unknown as Prisma.InputJsonValue }
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

async function loadOwnedProduct(actor: ProductWriteActor, productId: number) {
  const product = await prisma.product.findFirst({
    where: actor.kind === 'merchant'
      ? { id: productId, merchantId: actor.merchantId }
      : { id: productId },
  })
  if (!product) throw notFound('商品不存在')
  return product
}

export async function patchProductContent(
  actor: ProductWriteActor,
  productId: number,
  input: PatchProductContentInput,
) {
  const owned = await loadOwnedProduct(actor, productId)
  const updatedFields: string[] = []
  const data: Prisma.ProductUncheckedUpdateInput = {}

  if (input.name !== undefined) {
    data.name = input.name
    updatedFields.push('name')
  }
  if (input.description !== undefined) {
    data.description = input.description
    updatedFields.push('description')
  }
  if (Object.prototype.hasOwnProperty.call(input, 'richDescription')) {
    data.richDescription = input.richDescription === ''
      ? null
      : await resolveRichDescription(input.richDescription, input.descriptionImages ?? [])
    updatedFields.push('richDescription')
  }
  if (input.visibility !== undefined) {
    data.visibility = input.visibility
    updatedFields.push('visibility')
  }
  if (input.details !== undefined) {
    data.details = input.details as Prisma.InputJsonValue
    updatedFields.push('details')
  }
  if (input.purchaseForm !== undefined) {
    data.purchaseForm = input.purchaseForm as unknown as Prisma.InputJsonValue
    updatedFields.push('purchaseForm')
  }

  const assigningTemplate = input.templateKey !== undefined || input.templateVersion !== undefined
  let assigningTemplateDefinition: ReturnType<typeof resolveWritableTemplate> = null
  if (assigningTemplate) {
    if (input.templateKey === undefined || input.templateVersion === undefined) {
      templateInvalid('templateKey 与 templateVersion 必须同时提供')
    }
    if (owned.templateKey != null || owned.templateVersion != null) {
      templateLocked('商品形态一经设定不可更换')
    }
    if (owned.status === 'active') {
      templateLocked('在售商品不能补齐形态')
    }
    assigningTemplateDefinition = resolveWritableTemplate(input.templateKey, input.templateVersion)
    if (!assigningTemplateDefinition) {
      templateInvalid('未知的商品模板或版本')
    }
    data.templateKey = input.templateKey
    data.templateVersion = input.templateVersion
    updatedFields.push('templateKey', 'templateVersion')
    if (input.attributes === undefined) {
      data.attributes = {}
    }
  }

  const nextTemplateKey = input.templateKey ?? owned.templateKey
  const nextTemplateVersion = input.templateVersion ?? owned.templateVersion
  let nextProductAttributes = asTemplateAttributes(
    assigningTemplate && input.attributes === undefined ? {} : owned.attributes,
  )
  if (input.attributes !== undefined) {
    if (!nextTemplateKey || nextTemplateVersion == null) {
      templateInvalid('请先补充商品形态再保存模板参数')
    }
    const mode = owned.status === 'active' ? 'publish' : 'draft'
    const validated = validateTemplateAttributes({
      templateKey: nextTemplateKey,
      templateVersion: nextTemplateVersion,
      attributes: input.attributes,
      mode,
      target: 'product',
      pathPrefix: '/attributes',
    })
    if (!validated.ok) {
      templateInvalid('商品参数不合法', validated.errors.map(error => ({
        field: error.path,
        message: error.message,
      })))
    }
    data.attributes = validated.value as Prisma.InputJsonValue
    nextProductAttributes = validated.value
    updatedFields.push('attributes')
  }
  if (input.images !== undefined) {
    const resolvedImages: ResolvedPlatformImage[] = []
    for (const ref of input.images) {
      resolvedImages.push(await resolvePlatformPublicImage(ref as PlatformMediaRef))
    }
    data.images = resolvedImages.map(image => image.canonicalUrl)
    data.imageUrl = resolvedImages[0]?.canonicalUrl ?? null
    updatedFields.push('images')
  }
  let categoryId: number | undefined
  let categoryType: string | undefined
  if (input.categoryId !== undefined) {
    const resolved = await resolveProductCategory({ categoryId: input.categoryId })
    categoryId = resolved.categoryId
    categoryType = resolved.type
    updatedFields.push('categoryId')
  }

  const updated = await prisma.$transaction(async tx => {
    await lockProductRow(tx, productId)
    const current = await tx.product.findFirst({
      where: actor.kind === 'merchant'
        ? { id: productId, merchantId: actor.merchantId }
        : { id: productId },
    })
    if (!current) throw notFound('商品不存在')
    if (current.contentVersion !== input.expectedContentVersion) {
      throw new HttpError(409, CATALOG_ERROR_CODES.PRODUCT_CONTENT_CHANGED as ErrorCode, '商品内容已更新，请刷新后重试')
    }
    if (assigningTemplate) {
      if (current.templateKey != null || current.templateVersion != null) {
        templateLocked('商品形态一经设定不可更换')
      }
      const template = assigningTemplateDefinition ?? resolveWritableTemplate(input.templateKey, input.templateVersion)
      if (!template) templateInvalid('未知的商品模板或版本')
      await assertTemplateAssignable(
        tx,
        productId,
        current,
        template,
        nextProductAttributes,
        input.purchaseForm ?? current.purchaseForm,
      )
    }
    if (current.status === 'active' && input.attributes !== undefined) {
      const templateKey = (typeof data.templateKey === 'string' ? data.templateKey : current.templateKey)
      const templateVersion = typeof data.templateVersion === 'number'
        ? data.templateVersion
        : current.templateVersion
      const template = resolveWritableTemplate(templateKey, templateVersion)
      if (template) {
        const publish = validateTemplateAttributes({
          templateKey: template.key,
          templateVersion: template.version,
          attributes: input.attributes,
          mode: 'publish',
          target: 'product',
          pathPrefix: '/attributes',
        })
        if (!publish.ok) {
          templateInvalid('在售商品保存必须保持模板参数完整', publish.errors.map(error => ({
            field: error.path,
            message: error.message,
          })))
        }
      }
    }
    const updatedRow = await tx.product.update({
      where: { id: productId },
      data: {
        ...data,
        ...(categoryId != null ? { categoryId, type: categoryType } : {}),
        contentVersion: { increment: 1 },
      },
      select: { id: true, contentVersion: true },
    })
    if (current.status === 'active') {
      const readiness = await checkProductReadiness(productId, tx, { requireCurrentlySellable: false })
      if (!readiness.ready) notReadyError(readiness)
    }
    return updatedRow
  })

  await invalidateProductPublicCache(productId, { detail: true, list: true })
  return { id: updated.id, contentVersion: updated.contentVersion, updatedFields }
}

export async function getProductEditor(actor: ProductWriteActor, productId: number) {
  const product = await prisma.product.findFirst({
    where: actor.kind === 'merchant'
      ? { id: productId, merchantId: actor.merchantId }
      : { id: productId },
    include: {
      offers: { orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] },
      externalCatalogLink: {
        select: {
          descriptionCheckedAt: true,
          acceptedDescriptionHash: true,
          latestDescriptionHash: true,
        },
      },
    },
  })
  if (!product) throw notFound('商品不存在')

  const ownsOffers = actor.kind === 'merchant' || product.merchantId == null
  const isXboard = product.externalCatalogLink != null
  const readiness = await checkProductReadiness(productId)
  const publicationIssues = readiness.details.map(item => ({
    code: item.code,
    message: item.reason ?? item.field,
    path: item.field.startsWith('/') ? item.field : `/${item.field}`,
  }))

  const offers = product.offers.map(offer => {
    const secrets = ownsOffers
      ? {
          fixedContent: offer.fixedStructuredContent == null ? offer.fixedContent : null,
          fixedStructuredContent: offer.fixedStructuredContent,
        }
      : { fixedContent: null, fixedStructuredContent: null }
    return {
      id: offer.id,
      name: offer.name,
      price: offer.price,
      originalPrice: offer.originalPrice,
      status: offer.status,
      sortOrder: offer.sortOrder,
      isDefault: offer.isDefault,
      deliveryMode: offer.deliveryMode,
      stockMode: offer.stockMode,
      stock: offer.stock,
      validityDays: offer.validityDays,
      fixedContentType: offer.fixedContentType,
      fixedFileId: offer.fixedFileId,
      deliveryFields: offer.deliveryFields,
      autoProvision: offer.autoProvision,
      attributes: offer.attributes,
      checkoutVersion: computeOfferCheckoutVersion(offer),
      ...secrets,
    }
  })

  return {
    product: {
      id: product.id,
      status: product.status,
      merchantId: product.merchantId,
      contentVersion: product.contentVersion,
      templateKey: product.templateKey,
      templateVersion: product.templateVersion,
      name: product.name,
      categoryId: product.categoryId,
      description: product.description,
      richDescription: product.richDescription,
      descriptionImages: await listPersistedDescriptionImages(product.richDescription),
      images: product.images.map(url => ({ url, ref: null })),
      visibility: product.visibility,
      attributes: product.attributes,
      details: product.details,
      purchaseForm: product.purchaseForm,
    },
    offers,
    capabilities: {
      editContent: true,
      manageOffers: ownsOffers,
      manageAvailability: ownsOffers,
      manageAssurance: actor.kind === 'admin' || actor.kind === 'merchant',
      applyAssurance: actor.kind === 'merchant' && product.merchantId != null,
      adoptSourceDescription: actor.kind === 'admin' && isXboard,
    },
    sourceDescription: isXboard
      ? {
          checkedAt: product.externalCatalogLink?.descriptionCheckedAt?.toISOString() ?? null,
          changedSinceAccepted: product.externalCatalogLink?.acceptedDescriptionHash == null
            ? null
            : product.externalCatalogLink.acceptedDescriptionHash !== product.externalCatalogLink.latestDescriptionHash,
          hasAcceptedVersion: product.externalCatalogLink?.acceptedDescriptionHash != null,
        }
      : null,
    publicationIssues,
  }
}
