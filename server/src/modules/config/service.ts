import { businessRegistry } from '../../lib/businessRegistry.js'
import { getSystemConfigValue } from '../../lib/systemConfig.js'
import { getPublicCategoryRegistry } from '../catalog/registry.js'

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
    catalog,
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
    getPublicCategoryRegistry(),
  ])

  return {
    // SPEC-CATALOG-OPS-001 §7.1：productCategories/productTypes 现在来自 DB
    // 驱动的公开 registry（只含 active 分类）；legacy productTypes 投影自同一
    // 数据源并标 deprecated。不再以 hard-coded businessRegistry 为权威。
    productCategories: catalog.productCategories,
    productTypes: catalog.productTypes,
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
