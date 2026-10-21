import type { ProductEditorOffer } from '../../../api/catalog'
import type { FulfillmentRule, ProductTemplateDefinition, TemplateAttributes } from '../../../types/catalog'
import { structuredRequirementFor } from '../../../components/catalog/wizard/fulfillment'
import { parseDeliveryFields, parseStructuredContent } from './offerDrafts'

export type StructuredRequirement = FulfillmentRule['requireStructuredDelivery']

export function offerStructuredRequirement(
  offer: ProductEditorOffer,
  template: ProductTemplateDefinition | null,
  productAttributes: TemplateAttributes,
): StructuredRequirement {
  return template
    ? structuredRequirementFor(template, productAttributes, offer.deliveryMode, 'manual_service')
    : 'none'
}

export function shouldEditDeliveryFields(offer: ProductEditorOffer, requirement: StructuredRequirement): boolean {
  if (requirement === 'inventory_fields') return offer.deliveryMode === 'instant_inventory'
  return parseDeliveryFields(offer.deliveryFields).length > 0
}

export function shouldEditStructuredContent(offer: ProductEditorOffer, requirement: StructuredRequirement): boolean {
  if (offer.fixedContentType === 'file') return false
  if (requirement === 'fixed_fields') return offer.deliveryMode === 'instant_fixed'
  return parseStructuredContent(offer.fixedStructuredContent).fields.length > 0
}
