import { businessRegistry } from '../../lib/businessRegistry.js'
import { getSystemConfigValues } from '../../lib/systemConfig.js'
import { getPublicCategoryRegistry } from '../catalog/registry.js'
import { config } from '../../config/index.js'
import type { ProductAudience } from '../../lib/productCatalog/visibility.js'

export async function getConfigRegistry(
  audience: ProductAudience = 'guest',
) {
  const [{
    defaultPageSize,
    maxPageSize,
    notificationEnabled,
  }, catalog] = await Promise.all([
    getSystemConfigValues(['defaultPageSize', 'maxPageSize', 'notificationEnabled']),
    getPublicCategoryRegistry(audience),
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
    pagination: {
      defaultPageSize,
      maxPageSize,
    },
    capabilities: {
      notifications: notificationEnabled === 1,
      notificationRealtime: notificationEnabled === 1 && config.notificationRealtime.enabled,
    },
  }
}
