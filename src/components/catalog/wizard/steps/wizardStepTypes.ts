import type { FulfillmentRule, TemplateAttributes } from '../../../../types/catalog'
import type { DeliveryField, DeliveryMode, StockMode } from '../../../../types/merchant'

/** 主规格默认名（与服务端 lib/offers.ts 的 DEFAULT_OFFER_NAME 一致）。 */
export const DEFAULT_OFFER_NAME = '默认规格'

export type FixedContentType = 'text' | 'url' | 'file'

export type StructuredRequirement = FulfillmentRule['requireStructuredDelivery']

export interface DeliverySelection {
  deliveryMode: DeliveryMode
  stockMode: StockMode
  fixedContentType: FixedContentType
}

/** 附加规格：主规格由定价 + 交付两步的商品级字段构成。 */
export interface ExtraOffer {
  name: string
  price: string
  originalPrice: string
  deliveryMode: DeliveryMode
  stockMode: StockMode
  fixedContent: string
  fixedContentType: FixedContentType
  validityDays: string
  attributes: TemplateAttributes
  deliveryFields: DeliveryField[]
  structuredFields: DeliveryField[]
  structuredValues: Record<string, string>
}
