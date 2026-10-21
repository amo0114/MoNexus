import { assertMyDeliveryFile } from './deliveryFilePolicy.js'
import { assertOriginalPrice } from '../catalog/offerPolicy.js'
import { Prisma, type Offer } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { badRequest, notFound, HttpError } from '../../lib/httpError.js'
import { assertProductDeliveryConfiguration } from '../../lib/productCommercial.js'
import { invalidateProductPublicCache } from '../products/cache.js'
import { lockActiveWebhookConfigForShare } from '../orders/provisioningConfig.js'
import {
  parseStoredDeliveryFields,
  parseStoredStructuredContent,
  type DeliveryField,
  type StructuredDeliveryContent,
} from '../../lib/deliveryFields.js'
import { syncProductProjection, computeOfferCheckoutVersion } from '../../lib/offers.js'
import {
  canonicalFixedStructuredText,
  normalizeFixedStructuredContent,
} from '../catalog/structuredFixedContent.js'
import { lockProductRow } from '../catalog/productLock.js'
import { normalizeFakaOfferIntegration, assertOfferProvisionMutex } from '../../lib/fakaBridge/index.js'

import { withCheckoutVersion } from './offerSerialization.js'

type StructuredFixedWrite = {
  fixedContent: string | null
  structured: StructuredDeliveryContent | null
}

/** Same mutual-exclusion rules as offerAdmin.resolveStructuredFixedContent. */
function resolveStructuredFixedContent(
  structuredInput: unknown,
  fixedContent: string | null,
): StructuredFixedWrite {
  if (structuredInput == null) {
    return { fixedContent, structured: null }
  }
  if (fixedContent != null) {
    throw badRequest('结构化固定内容与 fixedContent 不能同时提交')
  }
  const structured = normalizeFixedStructuredContent(structuredInput)
  return { fixedContent: canonicalFixedStructuredText(structured), structured }
}

type OfferDeliveryContentWrite = StructuredFixedWrite & {
  writeDeliveryContent: boolean
  nextFixedFileId: number | null
  writeFixedFileId: boolean
  nextFixedContentType: string
}

/**
 * Merge offer delivery-content fields for PUT.
 * Structured in the payload is truth; text-only matching stored/canonical text
 * is a governance save that keeps structured; switching away from instant_fixed
 * drops leftover fixed fields unless the request supplies replacements.
 */
function resolveOfferDeliveryContentForUpdate(
  input: OfferWriteInput,
  offer: Offer,
  deliveryMode: string,
): OfferDeliveryContentWrite {
  const leavingInstantFixed = deliveryMode !== offer.deliveryMode && deliveryMode !== 'instant_fixed'
  let nextFixedFileId = 'fixedFileId' in input ? (input.fixedFileId ?? null) : offer.fixedFileId
  let writeFixedFileId = 'fixedFileId' in input
  let nextFixedContentType = input.fixedContentType ?? offer.fixedContentType

  if (leavingInstantFixed) {
    if (!('fixedFileId' in input)) {
      nextFixedFileId = null
      writeFixedFileId = true
    }
    if (!('fixedContentType' in input)) {
      nextFixedContentType = 'text'
    }
    if ('fixedStructuredContent' in input) {
      const incomingFixedContent = 'fixedContent' in input ? (input.fixedContent ?? null) : null
      const resolved = resolveStructuredFixedContent(input.fixedStructuredContent, incomingFixedContent)
      return {
        ...resolved,
        writeDeliveryContent: true,
        nextFixedFileId,
        writeFixedFileId,
        nextFixedContentType,
      }
    }
    return {
      fixedContent: 'fixedContent' in input ? (input.fixedContent ?? null) : null,
      structured: null,
      writeDeliveryContent: true,
      nextFixedFileId,
      writeFixedFileId,
      nextFixedContentType,
    }
  }

  if ('fixedStructuredContent' in input) {
    const incomingFixedContent = 'fixedContent' in input
      ? (input.fixedContent ?? null)
      : (input.fixedStructuredContent != null ? null : offer.fixedContent)
    const resolved = resolveStructuredFixedContent(input.fixedStructuredContent, incomingFixedContent)
    return {
      ...resolved,
      writeDeliveryContent: true,
      nextFixedFileId,
      writeFixedFileId,
      nextFixedContentType,
    }
  }

  if ('fixedContent' in input) {
    const incoming = input.fixedContent ?? null
    const storedStructured = parseStoredStructuredContent(offer.fixedStructuredContent)
    if (storedStructured) {
      const canonical = canonicalFixedStructuredText(storedStructured)
      if (incoming === offer.fixedContent || incoming === canonical) {
        return {
          fixedContent: offer.fixedContent,
          structured: storedStructured,
          writeDeliveryContent: false,
          nextFixedFileId,
          writeFixedFileId,
          nextFixedContentType,
        }
      }
      throw badRequest('不能用纯文本覆盖已有的结构化固定内容')
    }
    return {
      fixedContent: incoming,
      structured: null,
      writeDeliveryContent: true,
      nextFixedFileId,
      writeFixedFileId,
      nextFixedContentType,
    }
  }

  return {
    fixedContent: offer.fixedContent,
    structured: parseStoredStructuredContent(offer.fixedStructuredContent),
    writeDeliveryContent: false,
    nextFixedFileId,
    writeFixedFileId,
    nextFixedContentType,
  }
}

// ---- Offers (P4a: SKU 管理) ----

export type OfferWriteInput = {
  name?: string
  price?: number
  originalPrice?: number | null
  status?: string
  deliveryMode?: string
  stockMode?: string
  stock?: number
  fixedContent?: string | null
  fixedContentType?: string
  // P5：file 形态挂载的交付文件；null 清空（配合切回 text/url）。
  fixedFileId?: number | null
  sortOrder?: number
  // P6a：订阅有效期天数；null = 永久。
  validityDays?: number | null
  // P4b：交付字段模板；null 清空回纯文本。已过 zod（deliveryFieldsSchema）。
  deliveryFields?: DeliveryField[] | null
  // P7b：自动开通开关。仅 manual_service 且无模板且商家已有 active webhook
  // 配置可为 true（服务端校验 + DB CHECK 兜底，硬验收 ④⑤）。
  // 与 FakaBridge externalIntegration 互斥。
  autoProvision?: boolean
  // FakaBridge：null 关闭；'faka_bridge' + externalSku 开通 Xboard。
  externalIntegration?: string | null
  externalSku?: string | null
  attributes?: Record<string, string | number | boolean | string[]>
  fixedStructuredContent?: unknown
  // Optional editor CAS (update only). Present → compare with current digest;
  // omitted → last-write-wins for legacy clients.
  expectedCheckoutVersion?: string
  // 设为默认规格（仅接受 true，事务内从原默认转移；不接受 false——
  // 取消默认必须通过在另一条上设默认完成，保证不变量恒成立）。
  isDefault?: boolean
}

/**
 * P7b：autoProvision 开启前置校验（硬验收 ④⑤）：人工服务 + 无交付模板 +
 * 商家已有 active webhook 配置。DB CHECK 兜底前两条；active 配置是业务
 * 前置（下单事务要冻结它，缺失时买家下单会 409 安全失败）。
 * FOR SHARE 锁 active 行（复审 P1 线性化）：与撤销的 FOR UPDATE 互斥——
 * 撤销先提交则此处查无 active 行、开启被拒；本事务先提交则撤销的关开关
 * 扫描必然覆盖刚开启的规格，不存在「开关开着但配置已撤销」的静默错配。
 */
async function assertAutoProvisionAllowed(
  tx: Prisma.TransactionClient,
  merchantId: number,
  autoProvision: boolean,
  deliveryMode: string,
  deliveryFields: readonly unknown[] | null | undefined
) {
  if (!autoProvision) return
  if (deliveryMode !== 'manual_service') {
    throw badRequest('自动开通仅支持人工服务规格')
  }
  if ((deliveryFields?.length ?? 0) > 0) {
    throw badRequest('带交付字段模板的规格暂不支持自动开通')
  }
  const active = await lockActiveWebhookConfigForShare(tx, merchantId)
  if (!active) {
    throw badRequest('请先在商家设置中配置自动开通 webhook，再开启该开关')
  }
}

/** instant_fixed 固定内容天然单值，不支持交付字段模板（P4b 决策点 2）。 */
function assertDeliveryFieldsAllowed(deliveryMode: string, deliveryFields: DeliveryField[] | null | undefined) {
  if (deliveryFields && deliveryFields.length > 0 && deliveryMode === 'instant_fixed') {
    throw badRequest('固定内容交付不支持交付字段模板')
  }
}

async function assertMyProduct(merchantId: number, productId: number) {
  const product = await prisma.product.findFirst({ where: { id: productId, merchantId }, select: { id: true } })
  if (!product) throw notFound('商品不存在')
}

function assertOfferCommercialInput(input: {
  price: number
  originalPrice?: number | null
  deliveryMode: string
  stockMode: string
  // 本次请求显式携带的库存(未改动时为 undefined);即时库存模式下"设置库存"
  // 会被拒绝,故不能把持久化的 offer.stock 塞进来误判。
  incomingStock?: number
  // 合并请求与库存后的有效容量,供 limited 模式非负校验。
  effectiveStock?: number
  fixedContent?: string | null
  fixedContentType: string
  fixedFileId?: number | null
  allowIncompleteFixedContent?: boolean
}) {
  assertOriginalPrice(input.price, input.originalPrice ?? null)
  assertProductDeliveryConfiguration({
    deliveryMode: input.deliveryMode,
    stockMode: input.stockMode,
    incomingStock: input.incomingStock,
    effectiveStock: input.effectiveStock,
    fixedContent: input.fixedContent ?? undefined,
    fixedContentType: input.fixedContentType,
    fixedFileId: input.fixedFileId ?? null,
    // 规格是 file 形态的唯一入口；商品级写路径保持 text/url。
    allowFileForm: true,
    allowIncompleteFixedContent: input.allowIncompleteFixedContent,
  })
}

export async function listMyOffers(merchantId: number, productId: number) {
  await assertMyProduct(merchantId, productId)
  const offers = await prisma.offer.findMany({
    where: { productId },
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    // P5：管理 UI 需要展示已挂载文件的名称/大小/可用状态。
    include: {
      fixedFile: { select: { fileName: true, size: true, status: true } },
      _count: { select: { inventory: { where: { status: 'available' } } } },
    },
  })

  // 即时库存的可售量由 InventoryItem(status=available) 唯一决定；Offer.stock
  // 是旧投影，不能直接返回给 Offer-first 工作台，否则导入后仍显示 0。
  return offers.map(({ _count, ...offer }) => withCheckoutVersion(offer, {
    stock: offer.deliveryMode === 'instant_inventory' ? _count.inventory : offer.stock,
    availableStock: offer.deliveryMode === 'instant_inventory' ? _count.inventory : undefined,
  }))
}

/**
 * 校验并写入一条规格（不同步投影，调用方负责在同事务里收尾）。
 * createMyOffer 与向导原子发布（createMyProduct 的 offers）共用。
 */
export async function insertOffer(
  tx: Prisma.TransactionClient,
  merchantId: number,
  productId: number,
  input: OfferWriteInput & { name: string; price: number }
) {
  const product = await lockProductRow(tx, productId)
  const allowIncompleteFixedContent = product.status === 'draft' && product.templateKey != null
  const deliveryMode = input.deliveryMode ?? 'instant_inventory'
  const stockMode = input.stockMode ?? (deliveryMode === 'instant_inventory' ? 'limited' : 'unlimited')
  const fixedContentType = input.fixedContentType ?? 'text'
  const fixedFileId = input.fixedFileId ?? null
  const structuredWrite = resolveStructuredFixedContent(
    input.fixedStructuredContent,
    input.fixedContent ?? null,
  )
  assertOfferCommercialInput({
    price: input.price,
    originalPrice: input.originalPrice ?? null,
    deliveryMode,
    stockMode,
    incomingStock: input.stock,
    effectiveStock: input.stock ?? (allowIncompleteFixedContent ? 0 : undefined),
    fixedContent: structuredWrite.fixedContent,
    fixedContentType,
    fixedFileId,
    allowIncompleteFixedContent,
  })
  assertDeliveryFieldsAllowed(deliveryMode, input.deliveryFields)
  await assertAutoProvisionAllowed(tx, merchantId, input.autoProvision ?? false, deliveryMode, input.deliveryFields)
  if (fixedFileId != null) {
    await assertMyDeliveryFile(tx, merchantId, fixedFileId)
  }

  // v1: platform FakaBridge credentials are global — only admins may attach SKUs.
  if (input.externalIntegration != null && input.externalIntegration !== '') {
    throw badRequest('FakaBridge 外部开通仅平台管理员可配置，商家请使用自动开通 webhook 或人工交付')
  }
  if (input.externalSku != null && input.externalSku !== '') {
    throw badRequest('FakaBridge externalSku 仅平台管理员可配置')
  }
  const faka = normalizeFakaOfferIntegration({
    externalIntegration: null,
    externalSku: null,
    deliveryMode,
  })
  assertOfferProvisionMutex({
    autoProvision: input.autoProvision ?? false,
    externalIntegration: faka.externalIntegration,
  })

  return tx.offer.create({
    data: {
      productId,
      name: input.name,
      price: input.price,
      originalPrice: input.originalPrice ?? null,
      status: input.status ?? 'active',
      deliveryMode,
      stockMode,
      stock: deliveryMode === 'instant_inventory' ? 0 : (input.stock ?? 0),
      fixedContent: structuredWrite.fixedContent,
      fixedContentType,
      fixedFileId,
      sortOrder: input.sortOrder ?? 0,
      // P6a：订阅有效期；null = 永久。
      validityDays: input.validityDays ?? null,
      deliveryFields: input.deliveryFields ?? undefined,
      // P7b：自动开通开关（上方已过前置校验 + 与 Faka 互斥）。
      autoProvision: input.autoProvision ?? false,
      externalIntegration: faka.externalIntegration,
      externalSku: faka.externalSku,
      ...('attributes' in input && input.attributes != null
        ? { attributes: input.attributes as Prisma.InputJsonValue }
        : {}),
      ...(structuredWrite.structured != null
        ? { fixedStructuredContent: structuredWrite.structured as unknown as Prisma.InputJsonValue }
        : {}),
    },
  })
}

export async function createMyOffer(
  merchantId: number,
  productId: number,
  input: OfferWriteInput & { name: string; price: number }
) {
  await assertMyProduct(merchantId, productId)
  const offer = await prisma.$transaction(async tx => {
    const created = await insertOffer(tx, merchantId, productId, input)
    await syncProductProjection(tx, productId)
    return created
  })

  await invalidateProductPublicCache(productId, { detail: true, list: true })
  return withCheckoutVersion(offer)
}

export async function updateMyOffer(
  merchantId: number,
  productId: number,
  offerId: number,
  input: OfferWriteInput
) {
  await assertMyProduct(merchantId, productId)

  const updated = await prisma.$transaction(async tx => {
    // Same lock order as admin patchAdminOffer: Product FOR UPDATE, then load
    // the offer, then CAS. Without the row lock two transactions can both read
    // the same digest and both write.
    const product = await lockProductRow(tx, productId)
    const offer = await tx.offer.findFirst({ where: { id: offerId, productId } })
    if (!offer) throw notFound('规格不存在')

    // expectedCheckoutVersion present → CAS against current digest; omitted →
    // last-write-wins for legacy clients (two concurrent editors can both save).
    if (input.expectedCheckoutVersion != null
      && input.expectedCheckoutVersion !== computeOfferCheckoutVersion(offer)) {
      throw new HttpError(409, 'CHECKOUT_CHANGED', '商品信息已变化，请重新确认')
    }

    const deliveryMode = input.deliveryMode ?? offer.deliveryMode
    if (deliveryMode !== offer.deliveryMode) {
      // 与商品级规则一致：已有库存记录或订单的规格不能改履约模式。
      const [inventoryCount, orderCount] = await Promise.all([
        tx.inventoryItem.count({ where: { offerId: offer.id } }),
        tx.order.count({ where: { offerId: offer.id } }),
      ])
      if (inventoryCount > 0 || orderCount > 0) {
        throw badRequest('该规格已有库存记录或订单，不能修改履约模式')
      }
    }
    const stockMode = input.stockMode
      ?? (deliveryMode !== offer.deliveryMode
        ? (deliveryMode === 'instant_inventory' ? 'limited' : 'unlimited')
        : offer.stockMode)
    const contentWrite = resolveOfferDeliveryContentForUpdate(input, offer, deliveryMode)
    const nextFixedContent = contentWrite.fixedContent
    const writeDeliveryContent = contentWrite.writeDeliveryContent
    const nextFixedFileId = contentWrite.nextFixedFileId
    const writeFixedFileId = contentWrite.writeFixedFileId
    const fixedContentType = contentWrite.nextFixedContentType
    if (deliveryMode !== 'instant_fixed' && contentWrite.structured != null) {
      throw badRequest('仅固定内容交付支持结构化固定内容')
    }
    // P4b：合并后的模板不得出现在 instant_fixed 规格上（含"改模式但留模板"）。
    const nextDeliveryFields = 'deliveryFields' in input
      ? input.deliveryFields ?? null
      : parseStoredDeliveryFields(offer.deliveryFields)
    assertDeliveryFieldsAllowed(deliveryMode, nextDeliveryFields)
    // P7b：合并后的开关状态必须整体合法（含"改模式/加模板但留开关"的组合）。
    const nextAutoProvision = input.autoProvision ?? offer.autoProvision
    await assertAutoProvisionAllowed(tx, merchantId, nextAutoProvision, deliveryMode, nextDeliveryFields)
    assertOfferCommercialInput({
      price: input.price ?? offer.price,
      originalPrice: 'originalPrice' in input ? (input.originalPrice ?? null) : offer.originalPrice,
      deliveryMode,
      stockMode,
      // 仅当本次显式改库存时才作为"设置库存"判定（即时库存模式会拒绝）；
      // 有效容量取合并值供 limited 非负校验。
      incomingStock: input.stock,
      effectiveStock: input.stock ?? offer.stock,
      fixedContent: nextFixedContent,
      fixedContentType,
      fixedFileId: nextFixedFileId,
      allowIncompleteFixedContent: product.status === 'draft' && product.templateKey != null,
    })
    if (nextFixedFileId != null && nextFixedFileId !== offer.fixedFileId) {
      await assertMyDeliveryFile(tx, merchantId, nextFixedFileId)
    }

    // FakaBridge：请求触碰 integration/sku，或规格已启用 faka 时（履约模式变更也要重验）。
    const fakaFieldsTouched = 'externalIntegration' in input || 'externalSku' in input
    if (fakaFieldsTouched) {
      const ei = 'externalIntegration' in input ? input.externalIntegration : null
      const es = 'externalSku' in input ? input.externalSku : null
      if ((ei != null && ei !== '') || (es != null && es !== '')) {
        throw badRequest('FakaBridge 外部开通仅平台管理员可配置，商家请使用自动开通 webhook 或人工交付')
      }
    }
    const nextExternalIntegration = fakaFieldsTouched
      ? ('externalIntegration' in input ? input.externalIntegration : offer.externalIntegration)
      : offer.externalIntegration
    const nextExternalSku = fakaFieldsTouched
      ? ('externalSku' in input ? input.externalSku : offer.externalSku)
      : offer.externalSku
    const mustValidateFaka =
      fakaFieldsTouched || offer.externalIntegration != null || nextExternalIntegration != null
    const fakaUpdate = mustValidateFaka
      ? normalizeFakaOfferIntegration(
          {
            externalIntegration: nextExternalIntegration,
            externalSku: nextExternalSku,
            deliveryMode,
          },
          { requireConfigured: nextExternalIntegration === 'faka_bridge' }
        )
      : null

    const effectiveExternalIntegration =
      fakaUpdate != null ? fakaUpdate.externalIntegration : offer.externalIntegration
    assertOfferProvisionMutex({
      autoProvision: nextAutoProvision,
      externalIntegration: effectiveExternalIntegration,
    })

    // 设为默认：先清旧默认再随本次更新立新默认（同事务；部分唯一索引兜底并发）。
    // 取消默认只能通过在另一条上设默认完成，保证"每商品恰有一条默认"不变量。
    if (input.isDefault === true && !offer.isDefault) {
      await tx.offer.updateMany({ where: { productId, isDefault: true }, data: { isDefault: false } })
    } else if (input.isDefault === false && offer.isDefault) {
      throw badRequest('不能直接取消默认规格，请在其他规格上设为默认')
    }

    const next = await tx.offer.update({
      where: { id: offer.id },
      data: {
        ...(input.isDefault === true ? { isDefault: true } : {}),
        ...(input.name != null ? { name: input.name } : {}),
        ...(input.price != null ? { price: input.price } : {}),
        ...('originalPrice' in input ? { originalPrice: input.originalPrice ?? null } : {}),
        ...(input.status != null ? { status: input.status } : {}),
        deliveryMode,
        stockMode,
        ...(input.stock != null ? { stock: input.stock } : {}),
        ...(writeDeliveryContent ? { fixedContent: nextFixedContent } : {}),
        fixedContentType,
        ...(writeFixedFileId ? { fixedFileId: nextFixedFileId } : {}),
        // P6a：改时长只影响新订单（快照冻结）；null = 改回永久。
        ...('validityDays' in input ? { validityDays: input.validityDays ?? null } : {}),
        // P7b：开关改动进 checkoutVersion，买家预览后改动会 409 重新确认。
        ...(input.autoProvision != null ? { autoProvision: input.autoProvision } : {}),
        ...(input.sortOrder != null ? { sortOrder: input.sortOrder } : {}),
        // 改模板仅影响后续导入/交付；已导入条目携带自包含快照，不回填。
        ...('deliveryFields' in input
          ? { deliveryFields: input.deliveryFields === null ? Prisma.DbNull : input.deliveryFields }
          : {}),
        ...('attributes' in input && input.attributes != null
          ? { attributes: input.attributes as Prisma.InputJsonValue }
          : {}),
        ...(writeDeliveryContent
          ? {
              fixedStructuredContent: contentWrite.structured == null
                ? Prisma.DbNull
                : contentWrite.structured as unknown as Prisma.InputJsonValue,
            }
          : {}),
        ...(deliveryMode === 'instant_inventory' && offer.deliveryMode !== 'instant_inventory'
          ? { stock: 0 }
          : {}),
        ...(fakaUpdate
          ? {
              externalIntegration: fakaUpdate.externalIntegration,
              externalSku: fakaUpdate.externalSku,
            }
          : {}),
      },
    })
    await syncProductProjection(tx, productId)
    return next
  })

  await invalidateProductPublicCache(productId, { detail: true, list: true })
  return withCheckoutVersion(updated)
}

export async function deleteMyOffer(merchantId: number, productId: number, offerId: number) {
  await assertMyProduct(merchantId, productId)

  await prisma.$transaction(async tx => {
    const offer = await tx.offer.findFirst({ where: { id: offerId, productId } })
    if (!offer) throw notFound('规格不存在')

    const total = await tx.offer.count({ where: { productId } })
    if (total <= 1) throw badRequest('商品至少保留一个规格，可改为下架该规格')

    // 有库存记录或订单的规格只能下架（inactive），不能删除——审计与快照回溯依赖它。
    const [inventoryCount, orderCount] = await Promise.all([
      tx.inventoryItem.count({ where: { offerId: offer.id } }),
      tx.order.count({ where: { offerId: offer.id } }),
    ])
    if (inventoryCount > 0 || orderCount > 0) {
      throw badRequest('该规格已有库存记录或订单，只能下架不能删除')
    }

    await tx.offer.delete({ where: { id: offer.id } })
    // 删除的是默认规格 → 自动把剩余规格里 sortOrder 最靠前的提为默认，
    // 保持"每商品恰有一条默认"的兼容路径不变量（无需商家额外操作）。
    if (offer.isDefault) {
      const next = await tx.offer.findFirst({
        where: { productId },
        orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      })
      if (next) await tx.offer.update({ where: { id: next.id }, data: { isDefault: true } })
    }
    await syncProductProjection(tx, productId)
  })

  await invalidateProductPublicCache(productId, { detail: true, list: true })
  return { deleted: true }
}
