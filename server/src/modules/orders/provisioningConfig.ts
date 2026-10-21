import type { Prisma } from '@prisma/client'

interface ActiveConfigLockTestHooks {
  /** FOR SHARE 加锁前调用（受控并发测试用：在此完成一次完整撤销）。 */
  beforeLock?: () => Promise<void>
  /** FOR SHARE 加锁后、事务提交前调用（受控并发测试用：在此发起并阻塞一次撤销）。 */
  afterLock?: (locked: { id: number } | null) => Promise<void>
}

let activeConfigLockTestHooks: ActiveConfigLockTestHooks | null = null

/** 测试注入缝：在 FOR SHARE 临界区前后插桩，构造确定性的生命周期竞争。 */
export function __setActiveConfigLockHooksForTests(hooks: ActiveConfigLockTestHooks | null) {
  activeConfigLockTestHooks = hooks
}

/**
 * 以 FOR SHARE 锁定商家当前 active 配置行（生命周期读侧线性化点）。
 * 返回 null = 此刻（含等待中的撤销提交后）已无 active 配置。
 * 调用方必须与后续依赖该配置的写入处于**同一事务**，锁才护得住整个临界区。
 */
export async function lockActiveWebhookConfigForShare(
  tx: Prisma.TransactionClient,
  merchantId: number
): Promise<{ id: number } | null> {
  if (activeConfigLockTestHooks?.beforeLock) await activeConfigLockTestHooks.beforeLock()
  const rows = await tx.$queryRaw<Array<{ id: number }>>`
    SELECT "id" FROM "MerchantWebhookConfig"
    WHERE "merchantId" = ${merchantId} AND "status" = 'active'
    FOR SHARE`
  const locked = rows.length > 0 ? { id: rows[0].id } : null
  if (activeConfigLockTestHooks?.afterLock) await activeConfigLockTestHooks.afterLock(locked)
  return locked
}
