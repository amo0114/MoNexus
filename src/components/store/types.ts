export type { ProductSummary as Product } from '../../types/product'

/** Disclosure rendered on a blended sponsored/editorial card (SPEC-CMI-UX-001 §4.3). */
export interface FeedDisclosure {
  kind: 'sponsored' | 'editorial'
  label: string
  publicReason?: string | null
}
