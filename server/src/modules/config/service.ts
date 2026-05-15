import { businessRegistry } from '../../lib/businessRegistry.js'
import { getSystemConfigValue } from '../../lib/systemConfig.js'

export async function getConfigRegistry() {
  const [defaultPageSize, maxPageSize, lowStockThreshold] = await Promise.all([
    getSystemConfigValue('defaultPageSize'),
    getSystemConfigValue('maxPageSize'),
    getSystemConfigValue('lowStockThreshold'),
  ])

  return {
    productTypes: businessRegistry.productTypes,
    deliveryModes: businessRegistry.deliveryModes,
    orderStatuses: businessRegistry.orderStatuses,
    settlementStatuses: businessRegistry.settlementStatuses,
    pagination: {
      defaultPageSize,
      maxPageSize,
    },
    inventory: {
      lowStockThreshold,
    },
  }
}
