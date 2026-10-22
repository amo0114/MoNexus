import type { GuestReviewState } from '../../types/catalog'

/** SPEC-CATALOG-VIS-001 §4.6: choosing public is a request, not a publish. */
export const PUBLIC_VISIBILITY_REVIEW_HINT = '保存后需管理员确认才能向游客展示，兑换始终需要登录'

export const ADMIN_GUEST_REVIEW_LABELS: Record<GuestReviewState, string> = {
  members_only: '仅登录可见',
  category_restricted: '分类仅登录可见',
  pending: '待公开审核',
  approved: '游客可见',
  rejected: '未获批准',
  revoked: '公开资格已撤销',
}

/** §4.5.1 fixed merchant-facing copy; no free-text reasons reach merchants. */
export const MERCHANT_GUEST_REVIEW_LABELS: Record<GuestReviewState, string> = {
  members_only: '仅登录可见',
  category_restricted: '分类仅登录可见',
  pending: '待公开审核',
  approved: '游客可见',
  rejected: '未获批准，修改内容后可重新提交',
  revoked: '公开资格已被撤销',
}
