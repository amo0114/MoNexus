import { badRequest } from './httpError.js'

/**
 * Runtime rules shared by every product author (administrator and merchant).
 *
 * Schemas validate request shape; this module validates the *effective*
 * product configuration after defaults and persisted values have been merged.
 * Keeping that distinction here prevents partial updates from bypassing the
 * same rules that apply at creation time.
 */
export interface ProductDeliveryConfiguration {
  deliveryMode: string
  stockMode: string
  /** A supplied numeric stock field in the current request. */
  incomingStock?: number
  /** The resulting numeric capacity after merging the request and DB state. */
  effectiveStock?: number
  fixedContent?: string | null
  fixedContentType: string
}

const HTTP_URL_PATTERN = /^https?:\/\/\S+$/i

export function assertProductDeliveryConfiguration(config: ProductDeliveryConfiguration) {
  if (!['instant_inventory', 'instant_fixed', 'manual_service'].includes(config.deliveryMode)) {
    throw badRequest('履约模式不在可用范围内')
  }
  if (!['limited', 'unlimited'].includes(config.stockMode)) {
    throw badRequest('库存模式不在可用范围内')
  }
  if (!['text', 'url'].includes(config.fixedContentType)) {
    throw badRequest('固定内容类型不在可用范围内')
  }

  if (config.deliveryMode !== 'instant_fixed' && config.fixedContent != null) {
    throw badRequest('仅固定内容交付支持 fixedContent')
  }

  if (config.deliveryMode === 'instant_inventory') {
    if (config.stockMode !== 'limited') {
      throw badRequest('即时库存发货必须为限量库存')
    }
    // One inventory item is one deliverable secret. Product.stock must never
    // become a second writeable source of truth for this delivery mode.
    if (typeof config.incomingStock === 'number') {
      throw badRequest('即时库存发货的库存请通过库存导入管理')
    }
    return
  }

  if (config.deliveryMode === 'instant_fixed') {
    const content = config.fixedContent?.trim()
    if (!content) {
      throw badRequest('固定内容交付必须填写交付内容')
    }
    if (config.fixedContentType === 'url' && (content.length > 2048 || !HTTP_URL_PATTERN.test(content))) {
      throw badRequest('链接必须以 http(s):// 开头且不超过 2048 字符')
    }
  }

  if (config.stockMode === 'limited') {
    if (!Number.isInteger(config.effectiveStock) || (config.effectiveStock as number) < 0) {
      throw badRequest('限量库存必须填写非负整数库存数量')
    }
  }
}

/**
 * `images` is canonical; `imageUrl` remains the backwards-compatible cover
 * alias. Normalize writes so all API surfaces return the same cover.
 */
export function normalizeProductImageFields<T extends { imageUrl?: string | null; images?: string[] }>(
  data: T,
  currentImages: string[] = []
) {
  if (data.images !== undefined) {
    return { ...data, imageUrl: data.images[0] ?? null }
  }
  if (data.imageUrl !== undefined) {
    return {
      ...data,
      // Replacing a cover should reorder the existing gallery rather than
      // silently duplicating its former second image.
      images: data.imageUrl == null
        ? []
        : [data.imageUrl, ...currentImages.filter(image => image !== data.imageUrl)],
    }
  }
  return data
}
