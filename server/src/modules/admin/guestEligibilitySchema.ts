import { z } from 'zod'

/**
 * SPEC-CATALOG-VIS-001 §4.5 / §4.6（P1.5-A）——游客公开准入审批接口契约。
 *
 * 接口：POST /api/admin/products/:id/guest-eligibility
 *
 * 两个 expected 值都必须携带（§4.5「提交批准/拒绝必须携带这两个 expected 值」）：
 *   - expectedPublicContentRevision：管理员打开审批时看到的商品公开内容版本；
 *   - expectedEligibilityVersion：同一次读取得到的准入记录版本（无记录时传 0）。
 *
 * 任一不匹配即 409，要求刷新后重试。这样：
 *   - 「批准 v1 时商品已改成 v2」→ revision 不匹配 → 409；
 *   - 「两个管理员同时操作同一条记录」→ version 不匹配 → 后到者 409，
 *     已被撤销的审批不会被晚到的旧批准覆盖。
 */

export const GUEST_ELIGIBILITY_ACTIONS = ['approve', 'reject', 'revoke'] as const
export type GuestEligibilityAction = (typeof GUEST_ELIGIBILITY_ACTIONS)[number]

/**
 * 有限原因码（§4.3「reasonCode：人工来源和有限原因码」）。
 * 撤销固定写 'revoked'，不接受调用方自定义，避免自由文本进入审计。
 */
export const GUEST_ELIGIBILITY_REASON_CODES = [
  'rejected',
  'revoked',
  'content_changed',
  'manual',
] as const
export type GuestEligibilityReasonCode = (typeof GUEST_ELIGIBILITY_REASON_CODES)[number]

export const guestEligibilityActionSchema = z.object({
  action: z.enum(GUEST_ELIGIBILITY_ACTIONS, {
    message: 'action 只能是 approve / reject / revoke',
  }),
  expectedPublicContentRevision: z.number().int().min(1, 'expectedPublicContentRevision 必须为正整数'),
  // 无记录时为 0（尚未创建）。
  expectedEligibilityVersion: z.number().int().min(0, 'expectedEligibilityVersion 不能为负'),
  // reject 必须给原因；approve/revoke 的 reasonCode 由服务端固定写入。
  reasonCode: z.enum(GUEST_ELIGIBILITY_REASON_CODES).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.action === 'reject' && value.reasonCode === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['reasonCode'],
      message: '拒绝必须提供 reasonCode',
    })
  }
})

export type GuestEligibilityActionInput = z.infer<typeof guestEligibilityActionSchema>
