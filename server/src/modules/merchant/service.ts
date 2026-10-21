// Public merchant use cases. Implementations import their specific dependencies.
export { applyForMerchant, getMyMerchant, updateMyMerchant } from './profileService.js'
export {
  listMyProducts,
  createMyProduct,
  getMyProductReadiness,
  publishMyProduct,
  unpublishMyProduct,
  updateMyProduct,
} from './productService.js'
export {
  previewMyInventoryImport,
  previewMyOfferInventory,
  adjustMyProductCapacity,
  adjustMyOfferCapacity,
  importMyInventory,
  importMyOfferInventory,
  voidMyInventory,
  voidMyOfferInventory,
  listMyInventoryLogs,
} from './inventoryService.js'
export { listMyOffers, createMyOffer, updateMyOffer, deleteMyOffer } from './offerService.js'
export type { MerchantProductListFilters } from './productService.js'
export {
  listMyOrders,
  getMyOrderDetail,
  startOrderFulfillment,
  deliverOrderFulfillment,
  postOrderProgress,
  respondToOrderDispute,
  rejectOrder,
} from './orderService.js'

export { listMySettlements, getMyStats } from './dashboardQueries.js'
export { getSettlementEligibility } from '../orders/settlementPolicy.js'
