import { businessRegistry } from '../../lib/businessRegistry.js'
import { getSystemConfigValue } from '../../lib/systemConfig.js'

export async function getConfigRegistry() {
  const [
    defaultPageSize,
    maxPageSize,
    lowStockThreshold,
    silverThreshold,
    goldThreshold,
    platinumThreshold,
    silverBonusBps,
    goldBonusBps,
    platinumBonusBps,
  ] = await Promise.all([
    getSystemConfigValue('defaultPageSize'),
    getSystemConfigValue('maxPageSize'),
    getSystemConfigValue('lowStockThreshold'),
    getSystemConfigValue('memberTierSilverThreshold'),
    getSystemConfigValue('memberTierGoldThreshold'),
    getSystemConfigValue('memberTierPlatinumThreshold'),
    getSystemConfigValue('memberTierSilverBonusBps'),
    getSystemConfigValue('memberTierGoldBonusBps'),
    getSystemConfigValue('memberTierPlatinumBonusBps'),
  ])

  return {
    productTypes: businessRegistry.productTypes,
    deliveryModes: businessRegistry.deliveryModes,
    orderStatuses: businessRegistry.orderStatuses,
    settlementStatuses: businessRegistry.settlementStatuses,
    memberTiers: businessRegistry.memberTiers,
    memberTierThresholds: {
      silver: silverThreshold,
      gold: goldThreshold,
      platinum: platinumThreshold,
    },
    memberTierBonusBps: {
      bronze: 0,
      silver: silverBonusBps,
      gold: goldBonusBps,
      platinum: platinumBonusBps,
    },
    pagination: {
      defaultPageSize,
      maxPageSize,
    },
    inventory: {
      lowStockThreshold,
    },
  }
}
