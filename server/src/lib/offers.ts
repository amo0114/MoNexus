import { createHmac } from 'node:crypto'
import { Prisma, Offer } from '@prisma/client'
import { prisma } from './prisma.js'
import { config } from '../config/index.js'
import { badRequest, notFound, HttpError } from './httpError.js'
import { parseStoredDeliveryFields } from './deliveryFields.js'

type Client = typeof prisma | Prisma.TransactionClient

/** Offer 上与商品投影相关的商业/履约字段（创建默认 Offer 时从入参复制）。 */
export type OfferCommercialFields = {
  price: number
  originalPrice?: number | null
  deliveryMode: string
  stockMode: string
  stock?: number
  fixedContent?: string | null
  fixedContentType?: string
  // 复审 P2-2：创建路径也能给默认规格设订阅有效期（此前只有附加规格有入口）。
  validityDays?: number | null
  externalIntegration?: string | null
  externalSku?: string | null
}

export const DEFAULT_OFFER_NAME = '默认规格'

/**
 * 商品创建路径调用：与商品同事务生成默认 Offer（P4a 起 Offer 是价格与
 * 履约配置的唯一真相源，Product 上的同名列只是投影）。
 */
export async function createDefaultOffer(
  tx: Client,
  productId: number,
  fields: OfferCommercialFields,
  name: string = DEFAULT_OFFER_NAME
): Promise<Offer> {
  return tx.offer.create({
    data: {
      productId,
      name,
      isDefault: true,
      price: fields.price,
      originalPrice: fields.originalPrice ?? null,
      deliveryMode: fields.deliveryMode,
      stockMode: fields.stockMode,
      stock: fields.stock ?? 0,
      fixedContent: fields.fixedContent ?? null,
      fixedContentType: fields.fixedContentType ?? 'text',
      validityDays: fields.validityDays ?? null,
      externalIntegration: fields.externalIntegration ?? null,
      externalSku: fields.externalSku ?? null,
    },
  })
}

/**
 * 解析商品的"默认 Offer"（isDefault 显式标记；迁移 20260726150000 回填 +
 * 每商品唯一部分索引保证至多一条）。商品级写入（旧编辑路径）与未指定
 * offerId 的库存操作都落到它。绕过 API 的数据操作可能丢标记——回退最早
 * 一条，与迁移前语义一致。
 */
export async function getDefaultOffer(tx: Client, productId: number): Promise<Offer> {
  const offer =
    (await tx.offer.findFirst({ where: { productId, isDefault: true } })) ??
    (await tx.offer.findFirst({ where: { productId }, orderBy: { id: 'asc' } }))
  if (!offer) throw notFound('商品缺少规格数据')
  return offer
}

/**
 * 购买路径的 Offer 解析：显式 offerId 必须属于该商品且 active；未指定时
 * 解析为唯一 active Offer（单 SKU 透明），多个 active 时要求前端明确选择。
 */
export async function resolvePurchaseOffer(
  tx: Client,
  productId: number,
  offerId?: number
): Promise<Offer> {
  if (offerId != null) {
    const offer = await tx.offer.findFirst({ where: { id: offerId, productId } })
    if (!offer) throw notFound('规格不存在')
    if (offer.status !== 'active') throw badRequest('该规格已下架，请重新选择')
    return offer
  }
  const actives = await tx.offer.findMany({
    where: { productId, status: 'active' },
    orderBy: { id: 'asc' },
    take: 2,
  })
  if (actives.length === 0) throw badRequest('商品暂不可购买，请联系商家')
  if (actives.length > 1) throw badRequest('请选择商品规格')
  return actives[0]
}

/**
 * 把 Product 的商业投影列与 Offer 真相源对齐。写路径单点调用（Offer CRUD、
 * 订单事务里已用增量方式维护的除外）。
 * 投影语义：
 * - price/originalPrice：active Offer 中的最低价（列表"X 起"展示）；
 *   无 active Offer 时保留默认 Offer 价（商品此时不可购买，价格仅展示）。
 * - deliveryMode/stockMode/fixedContent*：默认 Offer 的配置（单 SKU 商品即
 *   其唯一配置；多 SKU 商品该列仅作列表过滤展示用途）。
 * - stock：active Offer 库存之和；sales：全部 Offer 销量之和。
 */
export async function syncProductProjection(tx: Client, productId: number) {
  const offers = await tx.offer.findMany({
    where: { productId },
    orderBy: { id: 'asc' },
  })
  if (offers.length === 0) return

  const actives = offers.filter(o => o.status === 'active')
  const defaultOffer = offers.find(o => o.isDefault) ?? offers[0]
  const cheapest = (actives.length > 0 ? actives : offers)
    .reduce((min, o) => (o.price < min.price ? o : min))

  await tx.product.update({
    where: { id: productId },
    data: {
      price: cheapest.price,
      originalPrice: cheapest.originalPrice,
      deliveryMode: defaultOffer.deliveryMode,
      stockMode: defaultOffer.stockMode,
      fixedContent: defaultOffer.fixedContent,
      fixedContentType: defaultOffer.fixedContentType,
      stock: actives.reduce((sum, o) => sum + o.stock, 0),
      sales: offers.reduce((sum, o) => sum + o.sales, 0),
    },
  })
}

/**
 * Offer 结算版本：对买家确认时应当稳定的全部规格配置做摘要——价格、状态、
 * 履约方式、库存模式、固定内容、交付字段模板。预览返回该值，下单携带
 * expectedCheckoutVersion 比对：商家在买家打开弹窗后改动任一项（含改模板、
 * 换交付方式、改固定内容）→ 409 CHECKOUT_CHANGED 要求重新确认，与
 * expectedPrice / purchaseFormVersion 同一套语义。
 * 不含 stock/sales（每笔成交都在变，与"买家确认的内容"无关）。
 *
 * 必须用服务端密钥 HMAC 而非裸 SHA-256：canonical 含 fixedContent（付费内容），
 * 版本值会在付款前返回给买家——低熵卡密/常见链接可被离线枚举候选值比对裸摘要
 * 猜出。密钥沿用幂等指纹同一 jwtSecret，买家不可自行计算。
 */
export function computeOfferCheckoutVersion(offer: Offer): string {
  const canonical = {
    price: offer.price,
    status: offer.status,
    deliveryMode: offer.deliveryMode,
    stockMode: offer.stockMode,
    fixedContent: offer.fixedContent ?? null,
    fixedContentType: offer.fixedContentType,
    deliveryFields: parseStoredDeliveryFields(offer.deliveryFields),
    // P5：换固定文件 = 买家确认的内容变化。null 不进 canonical——非 file
    // 形态的存量摘要字节不变（与 P4a offerId 的幂等兼容手法一致）。
    ...(offer.fixedFileId != null ? { fixedFileId: offer.fixedFileId } : {}),
    // P6a：改订阅时长 = 买家确认的商品变化。同一 null 不进 canonical 手法。
    ...(offer.validityDays != null ? { validityDays: offer.validityDays } : {}),
    // P7b：自动开通开关 = 买家履约与隐私合同的一部分（表单答案将外发给
    // 商家 webhook）。true 才进 canonical——存量摘要字节不变；买家预览后
    // 商家开/关开关都会改变摘要 → 409 强制重新确认（硬验收 ④）。
    ...(offer.autoProvision ? { autoProvision: true } : {}),
    // FakaBridge：改集成开关或 externalSku = 履约合同变化（会外呼开通订阅）。
    // null 不进 canonical，存量无集成规格摘要字节不变。
    ...((offer as { externalIntegration?: string | null }).externalIntegration != null
      ? {
          externalIntegration: (offer as { externalIntegration?: string | null }).externalIntegration,
          externalSku: (offer as { externalSku?: string | null }).externalSku ?? null,
        }
      : {}),
  }
  return createHmac('sha256', config.jwtSecret).update(JSON.stringify(canonical)).digest('hex').slice(0, 16)
}

function checkoutChanged(): HttpError {
  return new HttpError(409, 'CHECKOUT_CHANGED', '商品信息已变化，请重新确认')
}

/**
 * 带结算版本守卫的购买路径 Offer 解析。版本判定先于"下架/不可购买"判定：
 * 预览后规格被下架同样属于"买家确认的内容已变化"，必须 409 让前端重新报价
 * 刷新状态，而不是把买家留在旧结算弹窗里收 400。
 * 未携带版本（旧客户端）时与 resolvePurchaseOffer 行为完全一致。
 */
export async function resolvePurchaseOfferChecked(
  tx: Client,
  productId: number,
  offerId: number | undefined,
  expectedCheckoutVersion: string | undefined
): Promise<Offer> {
  if (expectedCheckoutVersion == null) {
    return resolvePurchaseOffer(tx, productId, offerId)
  }

  if (offerId != null) {
    // 允许 inactive：先比版本（status 在 canonical 内，下架必然版本不一致）。
    const offer = await tx.offer.findFirst({ where: { id: offerId, productId } })
    if (!offer) throw notFound('规格不存在')
    if (expectedCheckoutVersion !== computeOfferCheckoutVersion(offer)) throw checkoutChanged()
    // 版本匹配 ⇒ status 与预览时一致（预览只对 active 成功）；防御性保留。
    if (offer.status !== 'active') throw badRequest('该规格已下架，请重新选择')
    return offer
  }

  // 未指定规格：预览只可能在"恰好一个 active 规格"时成功。现在不是恰好一个
  //（被下架 / 新上架了第二个），都属于预览后变化 → 409 重新报价。
  const actives = await tx.offer.findMany({
    where: { productId, status: 'active' },
    orderBy: { id: 'asc' },
    take: 2,
  })
  if (actives.length !== 1) throw checkoutChanged()
  if (expectedCheckoutVersion !== computeOfferCheckoutVersion(actives[0])) throw checkoutChanged()
  return actives[0]
}

/**
 * 公开序列化：绝不包含 fixedContent（付费内容）。交付字段模板是公开元数据。
 * P5 file 形态只出 fixedContentType + 文件大小（「文件交付 · 约 X MB」），
 * 文件名/对象键都不出——购前元数据止步于此。
 */
export function serializePublicOffer(offer: Offer & { fixedFile?: { size: number } | null }) {
  return {
    id: offer.id,
    name: offer.name,
    price: offer.price,
    originalPrice: offer.originalPrice,
    status: offer.status,
    deliveryMode: offer.deliveryMode,
    stockMode: offer.stockMode,
    stock: offer.stock,
    sales: offer.sales,
    sortOrder: offer.sortOrder,
    fixedContentType: offer.fixedContentType,
    // P6a：购前可见的订阅时长（null = 永久，前端不渲染徽标）。
    validityDays: offer.validityDays,
    // P7b：购前披露——开启表示"购买前表单答案将发送至商家的自动开通服务"。
    autoProvision: offer.autoProvision,
    // FakaBridge：仅暴露是否外部开通（不公开 internal SKU 映射细节）。
    provisionsExternal:
      offer.externalIntegration === 'faka_bridge' ? ('faka_bridge' as const) : null,
    // P4b：买家购前可见将获得哪些字段；敏感的是字段"值"，不在此处。
    deliveryFields: parseStoredDeliveryFields(offer.deliveryFields),
    ...(offer.fixedContentType === 'file'
      ? { deliveryFileSize: offer.fixedFile?.size ?? null }
      : {}),
  }
}
