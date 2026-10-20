import { prisma } from '../../lib/prisma.js'
import { businessDayRange } from '../../lib/businessTime.js'
import { listSystemConfigs, updateSystemConfig as saveSystemConfig } from '../../lib/systemConfig.js'


export async function getStats() {
  const todayRange = businessDayRange()

  const [userCount, orderCount, totalPoints, todayOrders, todayCheckins, productCount, availableInventory] =
    await Promise.all([
      prisma.user.count(),
      prisma.order.count(),
      prisma.pointAccount.aggregate({ _sum: { balance: true } }),
      prisma.order.count({ where: { createdAt: todayRange } }),
      prisma.checkinRecord.count({ where: { createdAt: todayRange } }),
      prisma.product.count({ where: { status: 'active' } }),
      prisma.inventoryItem.count({ where: { status: 'available' } }),
    ])

  return {
    users: userCount,
    orders: orderCount,
    totalPoints: totalPoints._sum.balance ?? 0,
    todayOrders,
    todayCheckins,
    productCount,
    availableInventory,
  }
}

export async function listSystemConfig() {
  return listSystemConfigs()
}

export async function updateSystemConfig(adminUserId: number, key: string, value: number) {
  return saveSystemConfig(adminUserId, key, value)
}

export {
  listMerchants,
  getMerchantDetail,
  approveMerchant,
  rejectMerchant,
  suspendMerchant,
  setMerchantAgentPilot,
  updateCommission,
} from './merchantAdmin.js'

export { listAllSettlements, batchSettle } from './settlementAdmin.js'

export { archiveAdminProduct, restoreAdminProduct, purgeAdminProduct } from './productLifecycle.js'

export {
  patchAdminOffer,
  archiveAdminOffer,
  restoreAdminOffer,
  makeDefaultAdminOffer,
  previewRebindAdminOfferSku,
  rebindAdminOfferSku,
} from './offerAdmin.js'

export { previewAdminFakaSync, confirmAdminFakaSync } from '../catalog/fakaSync.js'

export { revokeDeliveryFile, listDeliveryFiles, listDeliveryFileGrants } from './deliveryFileAdmin.js'

export {
  listFakaBridgeTasks,
  getFakaBridgeTaskStats,
  retryFakaBridgeTask,
  forceFakaBridgeRevoke,
} from './fakaTaskAdmin.js'

export {
  createProduct,
  getProductReadiness,
  publishProduct,
  unpublishProduct,
  updateProduct,
  listAdminProducts,
  deleteAdminProduct,
} from './productAdmin.js'

export {
  previewInventory,
  previewOfferInventory,
  importInventory,
  importOfferInventory,
} from './inventoryAdmin.js'

export {
  setAdminFakaCapacity,
  listAdminFakaCatalog,
  previewAdminFakaPlan,
  importAdminFakaPlan,
  addAdminFakaOffers,
  PERIOD_OFFER_HINTS,
} from './fakaCatalogAdmin.js'

export {
  listUsers,
  adjustUserPoints,
  banUser,
  unbanUser,
} from './userAdmin.js'

export {
  listAllOrders,
  getOrderDetail,
  resolveOrder,
} from './orderAdmin.js'

export {
  listPointLogs,
  listLogs,
  listAdminLogs,
  getOfferReport,
} from './auditQueries.js'
