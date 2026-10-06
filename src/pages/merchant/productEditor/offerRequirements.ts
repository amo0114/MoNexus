import type { ProductEditorOffer } from '../../../api/catalog'
import type { FulfillmentRule, ProductTemplateDefinition, TemplateAttributes } from '../../../types/catalog'
import { deliveryModeFor } from '../../../components/catalog/wizard/fulfillment'
import { parseDeliveryFields, parseStructuredContent } from './offerDrafts'

export type StructuredRequirement = FulfillmentRule['requireStructuredDelivery']

export function offerStructuredRequirement(
  offer: ProductEditorOffer,
  template: ProductTemplateDefinition | null,
  productAttributes: TemplateAttributes,
): StructuredRequirement {
  return template
    ? structuredRequirementFor(template, productAttributes, offer.deliveryMode)
    : 'none'
}

function structuredRequirementFor(
  template: ProductTemplateDefinition,
  productAttributes: TemplateAttributes,
  deliveryMode: ProductEditorOffer['deliveryMode'],
): StructuredRequirement {
  const matched = template.fulfillmentRules.find(rule =>
    Object.entries(rule.whenProductAttributes).every(([key, expected]) => productAttributes[key] === expected),
  )
  if (matched) return matched.requireStructuredDelivery
  for (const rule of template.fulfillmentRules) {
    if (rule.requireStructuredDelivery === 'none') continue
    const modes = rule.configurations.flatMap(configuration => {
      return [deliveryModeFor(configuration) ?? 'manual_service']
    })
    if (modes.includes(deliveryMode)) return rule.requireStructuredDelivery
  }
  return 'none'
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
