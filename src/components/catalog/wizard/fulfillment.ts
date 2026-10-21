import type {
  FulfillmentConfiguration,
  FulfillmentRule,
  ProductTemplateDefinition,
  TemplateAttributes,
} from '../../../types/catalog'
import type { DeliveryMode } from '../../../types/merchant'

const DELIVERY_MODES = {
  inventory: 'instant_inventory',
  fixed_text: 'instant_fixed',
  fixed_url: 'instant_fixed',
  fixed_file: 'instant_fixed',
  manual: 'manual_service',
  merchant_webhook: 'manual_service',
  faka_bridge: 'manual_service',
} satisfies Record<FulfillmentConfiguration, DeliveryMode>

const deliveryModes = new Map<string, DeliveryMode>(Object.entries(DELIVERY_MODES))

/** Map known configurations only; unknown-value policy belongs to each caller. */
export function deliveryModeFor(configuration: FulfillmentConfiguration): DeliveryMode | undefined {
  return deliveryModes.get(configuration)
}

export function matchedFulfillmentRule(
  template: ProductTemplateDefinition,
  productAttributes: TemplateAttributes,
): FulfillmentRule | undefined {
  return template.fulfillmentRules.find(rule =>
    Object.entries(rule.whenProductAttributes).every(([key, expected]) => productAttributes[key] === expected),
  )
}

/** Existing editors retain the manual-service fallback for unknown configurations. */
export function structuredRequirementFor(
  template: ProductTemplateDefinition,
  productAttributes: TemplateAttributes,
  deliveryMode: DeliveryMode,
  unknownConfigurationMode?: DeliveryMode,
): FulfillmentRule['requireStructuredDelivery'] {
  const matched = matchedFulfillmentRule(template, productAttributes)
  if (matched) return matched.requireStructuredDelivery
  for (const rule of template.fulfillmentRules) {
    if (rule.requireStructuredDelivery === 'none') continue
    if (rule.configurations.some(configuration =>
      (deliveryModeFor(configuration) ?? unknownConfigurationMode) === deliveryMode,
    )) {
      return rule.requireStructuredDelivery
    }
  }
  return 'none'
}
