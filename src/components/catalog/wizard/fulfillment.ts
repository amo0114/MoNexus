import type { FulfillmentConfiguration } from '../../../types/catalog'
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
