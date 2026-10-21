import type { Offer } from '@prisma/client'
import { computeOfferCheckoutVersion } from '../../lib/offers.js'

export function withCheckoutVersion<T extends Offer>(offer: T, extras: Record<string, unknown> = {}) {
  return { ...offer, ...extras, checkoutVersion: computeOfferCheckoutVersion(offer) }
}
