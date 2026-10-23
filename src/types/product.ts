import type { MerchandisingProjection } from './merchandising'
import type { PublicAvailability } from './productAvailability'
import type { Offer } from './merchant'
import type { ProductDetails, TemplateAttributes } from './catalog'

export interface ProductSummary {
  id: number
  name: string
  description: string
  type: string
  category?: { id: number; code: string; label: string } | null
  icon: string
  imageUrl: string
  price: number
  originalPrice?: number
  stock: number
  stockMode?: string
  sales: number
  ratingAvg?: number
  ratingCount?: number
  merchandising?: MerchandisingProjection | null
  images?: string[]
  merchant?: { id: number; name: string } | null
  /** FakaBridge：Xboard 剩余名额（列表与详情同源）。 */
  fakaCapacity?: {
    remaining: number | null
    capacityLimit: number | null
    sellable: boolean
    source: 'xboard' | 'unavailable'
  } | null
  /** Optional only for previews/fixtures and pre-availability backends; read via readAvailabilityStatus. */
  availability?: PublicAvailability
}

export interface ProductMerchant {
  id: number
  name: string
  logoUrl?: string | null
  avatarUrl?: string | null
  title?: string | null
  badges?: string[] | null
  ratingAvg?: number
  ratingCount?: number
  sales?: number
  orderCount?: number
  productCount?: number
  responseTime?: string | null
  verified?: boolean
}

export interface ProductVideoSummary {
  moderation?: string
  moderationVersion?: number
  moderationReason?: string | null
  assetId: string
  durationMs: number
  width: number
  height: number
  hasAudio: boolean
}

export interface ProductDetail extends ProductSummary {
  promoVideo?: ProductVideoSummary | null
  richDescription?: string
  visibility?: 'public' | 'members_only'
  templateKey?: string | null
  templateVersion?: number | null
  contentVersion?: number
  attributes?: TemplateAttributes
  details?: ProductDetails
  merchant?: ProductMerchant | null
  assurance?: null | {
    label: string
    policyCode: string
    policyText: string
    validUntil: string
  }
  offers?: Array<Offer & { attributes?: TemplateAttributes }>
}
