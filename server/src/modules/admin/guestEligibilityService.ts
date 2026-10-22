import { prisma } from '../../lib/prisma.js'
import { HttpError, badRequest, notFound, type ErrorCode } from '../../lib/httpError.js'
import { lockProductRow } from '../catalog/productLock.js'
import type { GuestEligibilityActionInput } from './guestEligibilitySchema.js'

/**
 * SPEC-CATALOG-VIS-001 §4.5 / §4.5.1（P1.5-A）——游客公开准入的人工审批。
 *
 * 状态流转（§4.5.1）：
 *   无记录  + approve → approved，reviewedRevision = 当前 revision
 *   pending + approve → approved，reviewedRevision = 当前 revision
 *   pending + reject  → denied，  reviewedRevision = 当前 revision，附 reasonCode
 *   approved+ revoke  → denied，  reasonCode='revoked'；游客立即不可见
 *   denied  + approve → 允许（管理员改判；但内容未变时商家不能自助重提，
 *                       这是审批动作，不是商家申请）
 *
 * CAS 语义（§4.5）：
 *   - expectedPublicContentRevision 与商品当前 publicContentRevision 不等 → 409。
 *     「批准 v1 时商品已更新到 v2」必须失败，不能把旧内容的审核结论套到新内容上。
 *   - expectedEligibilityVersion 与准入记录当前 version 不等 → 409。
 *     两个管理员同时操作时后到者失败；已被撤销的审批不会被晚到的旧批准覆盖。
 *   - 无记录时 expectedEligibilityVersion 必须为 0，创建也走 CAS
 *     （§4.5「创建首条记录也需在商品锁内比较，避免并发首次批准」）。
 *
 * 事务只包含 PG 操作，不含外部服务调用（§4.5 末句）。
 */

const GUEST_ELIGIBILITY_CODES = {
  REVISION_CHANGED: 'PRODUCT_CONTENT_CHANGED',
  VERSION_CONFLICT: 'CONFLICT',
} as const

export interface GuestEligibilityView {
  productId: number
  publicContentRevision: number
  decision: 'pending' | 'approved' | 'denied' | null
  reviewedRevision: number | null
  version: number
  reviewedByUserId: number | null
  reviewedAt: string | null
  reasonCode: string | null
  /** 是否对游客可见（决定权在门禁，这里只是给管理员的一致性提示）。 */
  guestVisible: boolean
}

function toView(
  productId: number,
  revision: number,
  row: {
    decision: string
    reviewedRevision: number | null
    version: number
    reviewedByUserId: number | null
    reviewedAt: Date | null
    reasonCode: string | null
  } | null,
  productVisibility: string,
  categoryGuestVisibility: string,
): GuestEligibilityView {
  const decision = (row?.decision ?? null) as GuestEligibilityView['decision']
  return {
    productId,
    publicContentRevision: revision,
    decision,
    reviewedRevision: row?.reviewedRevision ?? null,
    version: row?.version ?? 0,
    reviewedByUserId: row?.reviewedByUserId ?? null,
    reviewedAt: row?.reviewedAt?.toISOString() ?? null,
    reasonCode: row?.reasonCode ?? null,
    // 门禁是四道门的 AND；这里只做一致性提示，不参与授权。
    guestVisible:
      productVisibility === 'public'
      && categoryGuestVisibility === 'public'
      && decision === 'approved'
      && row?.reviewedRevision === revision,
  }
}

async function loadState(tx: typeof prisma | Parameters<Parameters<typeof prisma.$transaction>[0]>[0], productId: number) {
  const product = await (tx as typeof prisma).product.findUnique({
    where: { id: productId },
    select: {
      id: true,
      visibility: true,
      publicContentRevision: true,
      category: { select: { guestVisibility: true } },
    },
  })
  if (!product) throw notFound('商品不存在')
  const row = await (tx as typeof prisma).productGuestEligibility.findUnique({
    where: { productId },
    select: {
      decision: true,
      reviewedRevision: true,
      version: true,
      reviewedByUserId: true,
      reviewedAt: true,
      reasonCode: true,
    },
  })
  return { product, row }
}

export async function getGuestEligibility(productId: number): Promise<GuestEligibilityView> {
  const { product, row } = await loadState(prisma, productId)
  return toView(
    productId,
    product.publicContentRevision,
    row,
    product.visibility,
    product.category?.guestVisibility ?? 'members_only',
  )
}

export async function applyGuestEligibilityAction(
  adminUserId: number,
  productId: number,
  input: GuestEligibilityActionInput,
): Promise<GuestEligibilityView> {
  return prisma.$transaction(async tx => {
    // 商品行锁：与所有展示写入共用同一把锁，保证「读 revision → 判定 CAS →
    // 写记录」不会被并发展示写入插入。锁顺序与其它写入一致（先锁商品）。
    await lockProductRow(tx, productId)

    const { product, row } = await loadState(tx, productId)
    const currentRevision = product.publicContentRevision
    const currentVersion = row?.version ?? 0

    // ── CAS：版本不匹配一律 409 ──────────────────────────────
    if (input.expectedPublicContentRevision !== currentRevision) {
      throw new HttpError(
        409,
        GUEST_ELIGIBILITY_CODES.REVISION_CHANGED as ErrorCode,
        '商品公开内容已更新，请刷新后重新审核',
      )
    }
    if (input.expectedEligibilityVersion !== currentVersion) {
      throw new HttpError(
        409,
        GUEST_ELIGIBILITY_CODES.VERSION_CONFLICT as ErrorCode,
        '该商品的准入状态已被其他管理员修改，请刷新后重试',
      )
    }

    const now = new Date()

    if (input.action === 'approve') {
      // 人工批准不修改 visibility / 分类 / 上架状态（§4.2）。
      // 它只写准入记录；商品仍可能是 members_only，那种情况下门禁照样拦住游客。
      if (row) {
        await tx.productGuestEligibility.update({
          where: { productId },
          data: {
            decision: 'approved',
            reviewedRevision: currentRevision,
            reviewedByUserId: adminUserId,
            reviewedAt: now,
            reasonCode: null,
            version: { increment: 1 },
          },
        })
      } else {
        // 创建首条记录同样已在商品锁内比较过（上面两个 CAS）。
        await tx.productGuestEligibility.create({
          data: {
            productId,
            decision: 'approved',
            reviewedRevision: currentRevision,
            reviewedByUserId: adminUserId,
            reviewedAt: now,
            version: 1,
          },
        })
      }
    } else if (input.action === 'reject') {
      if (!row) throw badRequest('该商品尚无待审核记录，无法拒绝')
      if (!input.reasonCode) throw badRequest('拒绝必须提供 reasonCode')
      await tx.productGuestEligibility.update({
        where: { productId },
        data: {
          decision: 'denied',
          reviewedRevision: currentRevision,
          reviewedByUserId: adminUserId,
          reviewedAt: now,
          reasonCode: input.reasonCode,
          version: { increment: 1 },
        },
      })
    } else {
      // revoke：撤销不新增状态值，写 denied + reasonCode='revoked'（§4.3）。
      if (!row) throw badRequest('该商品尚无准入记录，无法撤销')
      if (row.decision !== 'approved') throw badRequest('只有已批准的商品可以撤销')
      await tx.productGuestEligibility.update({
        where: { productId },
        data: {
          decision: 'denied',
          reviewedByUserId: adminUserId,
          reviewedAt: now,
          reasonCode: 'revoked',
          version: { increment: 1 },
          // reviewedRevision 保留：它记录的是"上次审的是哪一版"，
          // 撤销不改变这个事实。
        },
      })
    }

    await tx.adminLog.create({
      data: {
        adminUserId,
        action: `游客准入-${input.action}`,
        targetType: 'product',
        targetId: productId,
        detail: JSON.stringify({
          action: input.action,
          publicContentRevision: currentRevision,
          expectedEligibilityVersion: input.expectedEligibilityVersion,
          reasonCode: input.action === 'reject' ? input.reasonCode : (input.action === 'revoke' ? 'revoked' : null),
        }),
      },
    })

    const after = await loadState(tx, productId)
    return toView(
      productId,
      after.product.publicContentRevision,
      after.row,
      after.product.visibility,
      after.product.category?.guestVisibility ?? 'members_only',
    )
  })
}
