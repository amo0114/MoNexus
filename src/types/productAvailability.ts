/** Public sellability returned by product list/detail/recommendations (PLAN-PRODUCT-AVAILABILITY-001). */
export type AvailabilityStatus = 'available' | 'unavailable' | 'unknown'

export interface PublicAvailability {
  status: AvailabilityStatus
}
