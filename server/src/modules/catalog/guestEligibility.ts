import type { Prisma } from '@prisma/client'

/**
 * SPEC-CATALOG-VIS-001 §4.4 / §4.5（P1.5-A）——公开内容变更后的准入失效。
 *
 * 语义（与 §4.5.1 状态流转表一致）：
 *
 *   | 当前状态 | 触发 | 结果 |
 *   | 无记录   | 商品首次以 public 保存 | 创建 pending，reviewedRevision 为空 |
 *   | 任意状态 | 展示字段或 visibility 变化 | pending，reviewedRevision 保持原值 |
 *
 * 注意第二行：**不删除记录、不清空 reviewedRevision**，只把 decision 改回
 * pending 并递增 version。保留 reviewedRevision 是为了让「版本不匹配」这一
 * 事实在数据里可查（reviewedRevision 仍指向旧版本）；门禁只看
 * decision='approved' 且 reviewedRevision === publicContentRevision，
 * 因此 pending 一律不放行。
 *
 * 为什么必须与写入同事务：若 revision 递增成功而准入重置失败，商品会保持
 * 「旧批准仍匹配新内容的旧版本号」这种错误状态——实际上 revision 已变，
 * 匹配自然失效，但记录仍是 approved，会造成审批列表与实际不一致。
 * 反向（重置成功、revision 未增）会让旧批准继续放行新内容，是真正的泄露。
 * 两者都必须原子。
 */

/** 触发失效的展示字段集合（§4.4 第一段）。价格、库存、销量、评分不在其中。 */
export const PUBLIC_CONTENT_FIELDS = [
  'name',
  'description',
  'richDescription',
  'details',
  'attributes',
  'categoryId',
  'type',
  'icon',
  'imageUrl',
  'images',
  'templateKey',
  'templateVersion',
] as const

export type PublicContentField = (typeof PUBLIC_CONTENT_FIELDS)[number]

/**
 * 给定一次商品更新要写入的 data，判断它是否触及公开展示内容。
 *
 * visibility 单独判断（§4.4 第二段要求它同样递增并重置），
 * 因为它不是"展示内容"而是"可见性开关"，但失效语义相同。
 */
export function touchesPublicContent(data: Record<string, unknown>): boolean {
  for (const field of PUBLIC_CONTENT_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(data, field)) return true
  }
  return Object.prototype.hasOwnProperty.call(data, 'visibility')
}

export interface GuestEligibilityInvalidation {
  /** 商品新版本号（旧值 + 1）。 */
  publicContentRevision: number
  /** 失效后的准入状态，供调用方断言或记录审计。 */
  decision: 'pending'
  /** 是否新建了记录（原本无记录）。 */
  created: boolean
}

/**
 * 递增商品公开内容版本，并把准入记录重置为 pending。**必须在调用方已持有
 * 商品行锁（lockProductRow）的事务内调用。**
 *
 * 返回失效结果；无记录时创建一条 pending（§4.5.1 第一行）。
 */
export async function invalidateGuestEligibility(
  tx: Prisma.TransactionClient,
  productId: number,
): Promise<GuestEligibilityInvalidation> {
  const updated = await tx.product.update({
    where: { id: productId },
    data: { publicContentRevision: { increment: 1 } },
    select: { publicContentRevision: true },
  })

  const existing = await tx.productGuestEligibility.findUnique({
    where: { productId },
    select: { id: true },
  })

  if (!existing) {
    await tx.productGuestEligibility.create({
      data: {
        productId,
        decision: 'pending',
        // 新记录尚未被审核过，reviewedRevision 为空（§4.5.1 第一行）。
        reviewedRevision: null,
      },
    })
    return { publicContentRevision: updated.publicContentRevision, decision: 'pending', created: true }
  }

  await tx.productGuestEligibility.update({
    where: { productId },
    data: {
      decision: 'pending',
      // version 递增：审批 CAS 用它排序，展示变更也是一次状态迁移，
      // 必须让持有旧 version 的审批操作失效（§4.5）。
      version: { increment: 1 },
      reasonCode: 'content_changed',
      // reviewedRevision 刻意保留原值——它记录"上次审的是哪一版"。
    },
  })
  return { publicContentRevision: updated.publicContentRevision, decision: 'pending', created: false }
}

/**
 * 便捷封装：只在 data 确实触及公开内容时才失效。
 *
 * 调用方在**同一事务、同一行锁**内完成"写商品 + 失效"。返回 null 表示本次
 * 写入不影响公开审核状态（价格/库存/销量等），不递增 revision。
 */
export async function invalidateGuestEligibilityIfNeeded(
  tx: Prisma.TransactionClient,
  productId: number,
  data: Record<string, unknown>,
): Promise<GuestEligibilityInvalidation | null> {
  if (!touchesPublicContent(data)) return null
  return invalidateGuestEligibility(tx, productId)
}
