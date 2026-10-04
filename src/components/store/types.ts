// Storefront card contracts shared by `StorePage` and its extracted card.
//
// The page owns the list request, category/URL sync, feed blending, audience
// cache, pagination and scroll restore; it passes products and the blended-feed
// disclosure into `StoreProductCard`. These shapes live here so neither side
// has to import from the other's module.

import type { MerchandisingProjection } from '../../types/merchandising'

export interface Product {
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
}

/** Disclosure rendered on a blended sponsored/editorial card (SPEC-CMI-UX-001 §4.3). */
export interface FeedDisclosure {
  kind: 'sponsored' | 'editorial'
  label: string
  publicReason?: string | null
}
