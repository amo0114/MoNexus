/**
 * R09d：商品面板拆分后的共享类型。
 * 只有同时被表格模块与页面父层引用的类型才放这里，避免反向依赖。
 */

/**
 * 列表状态变更门控。
 * - blocked：对应原 productsRefreshError，列表刷新失败时禁止发起状态变更
 * - pendingIds：对应原 unpublishingProductIds，下架进行中的商品 id
 */
export interface ReleaseGate {
  blocked: boolean
  pendingIds: ReadonlySet<number>
}
