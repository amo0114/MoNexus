export type ExternalCapacitySnapshot = {
  sku: string
  planId: number | null
  /** null = unlimited on Xboard */
  capacityLimit: number | null
  activeUsers: number | null
  /** null = unlimited */
  remaining: number | null
  sellable: boolean
  source: 'xboard' | 'unavailable'
  reason?: string
}

export type ExternalOfferBinding = {
  externalIntegration?: string | null
  externalSku?: string | null
  deliveryMode?: string | null
}

export interface FulfillmentCatalog {
  isConfigured(): boolean
  normalizeBinding(input: ExternalOfferBinding, options?: { requireConfigured?: boolean }): {
    externalIntegration: string | null
    externalSku: string | null
  }
  usesAccountCapacity(offer: ExternalOfferBinding): boolean
  capacityForPublicRead(sku: string): ExternalCapacitySnapshot
  cachedCapacityByPlanId(planId: number): ExternalCapacitySnapshot | null
}
