export type AuditTone = 'success' | 'info' | 'warning' | 'danger' | 'neutral'

export interface AuditActionRegistryItem {
  value: string
  label: string
  tone: AuditTone
  group: string
}

export interface AuditTargetRegistryItem {
  value: string
  label: string
}

export const ADMIN_AUDIT_ACTION_REGISTRY: Record<string, AuditActionRegistryItem> = {
  // 系统与运维
  更新系统配置: { value: '更新系统配置', label: '更新系统配置', tone: 'warning', group: '系统与运维' },
  测试邮件投递: { value: '测试邮件投递', label: '测试邮件投递', tone: 'info', group: '系统与运维' },
  创建可移植备份: { value: '创建可移植备份', label: '创建可移植备份', tone: 'info', group: '系统与运维' },
  导入可移植备份: { value: '导入可移植备份', label: '导入可移植备份', tone: 'warning', group: '系统与运维' },

  // 分类、商品与库存
  创建分类: { value: '创建分类', label: '创建分类', tone: 'success', group: '分类、商品与库存' },
  更新分类: { value: '更新分类', label: '更新分类', tone: 'info', group: '分类、商品与库存' },
  启用分类: { value: '启用分类', label: '启用分类', tone: 'success', group: '分类、商品与库存' },
  停用分类: { value: '停用分类', label: '停用分类', tone: 'warning', group: '分类、商品与库存' },
  调整分类排序: { value: '调整分类排序', label: '调整分类排序', tone: 'info', group: '分类、商品与库存' },
  删除分类: { value: '删除分类', label: '删除分类', tone: 'danger', group: '分类、商品与库存' },
  审核通过分类申请: { value: '审核通过分类申请', label: '审核通过分类申请', tone: 'success', group: '分类、商品与库存' },
  拒绝分类申请: { value: '拒绝分类申请', label: '拒绝分类申请', tone: 'danger', group: '分类、商品与库存' },
  同步Xboard商品: { value: '同步Xboard商品', label: '同步外部平台商品', tone: 'info', group: '分类、商品与库存' },
  创建商品: { value: '创建商品', label: '创建商品', tone: 'success', group: '分类、商品与库存' },
  更新商品: { value: '更新商品', label: '更新商品', tone: 'info', group: '分类、商品与库存' },
  归档商品: { value: '归档商品', label: '归档商品', tone: 'warning', group: '分类、商品与库存' },
  恢复商品: { value: '恢复商品', label: '恢复商品', tone: 'success', group: '分类、商品与库存' },
  永久删除商品: { value: '永久删除商品', label: '永久删除商品', tone: 'danger', group: '分类、商品与库存' },
  导入库存: { value: '导入库存', label: '导入库存', tone: 'info', group: '分类、商品与库存' },
  同步Xboard人数限制: { value: '同步Xboard人数限制', label: '同步外部平台人数限制', tone: 'info', group: '分类、商品与库存' },
  从Xboard导入商品草稿: { value: '从Xboard导入商品草稿', label: '从外部平台导入商品草稿', tone: 'info', group: '分类、商品与库存' },
  追加Xboard规格: { value: '追加Xboard规格', label: '追加外部平台规格', tone: 'info', group: '分类、商品与库存' },
  更新规格: { value: '更新规格', label: '更新规格', tone: 'info', group: '分类、商品与库存' },
  归档规格: { value: '归档规格', label: '归档规格', tone: 'warning', group: '分类、商品与库存' },
  恢复规格: { value: '恢复规格', label: '恢复规格', tone: 'success', group: '分类、商品与库存' },
  设置默认规格: { value: '设置默认规格', label: '设置默认规格', tone: 'info', group: '分类、商品与库存' },
  重绑规格SKU: { value: '重绑规格SKU', label: '重绑规格SKU', tone: 'warning', group: '分类、商品与库存' },
  移除评价: { value: '移除评价', label: '移除评价', tone: 'danger', group: '分类、商品与库存' },

  // 用户、商家与权益
  增加积分: { value: '增加积分', label: '增加积分', tone: 'success', group: '用户、商家与权益' },
  扣除积分: { value: '扣除积分', label: '扣除积分', tone: 'warning', group: '用户、商家与权益' },
  封禁用户: { value: '封禁用户', label: '封禁用户', tone: 'danger', group: '用户、商家与权益' },
  解封用户: { value: '解封用户', label: '解封用户', tone: 'success', group: '用户、商家与权益' },
  审核通过商家: { value: '审核通过商家', label: '审核通过商家', tone: 'success', group: '用户、商家与权益' },
  拒绝商家入驻: { value: '拒绝商家入驻', label: '拒绝商家入驻', tone: 'danger', group: '用户、商家与权益' },
  停用商家: { value: '停用商家', label: '停用商家', tone: 'warning', group: '用户、商家与权益' },
  调整抽成比例: { value: '调整抽成比例', label: '调整抽成比例', tone: 'warning', group: '用户、商家与权益' },
  授予平台合作伙伴权益: { value: '授予平台合作伙伴权益', label: '授予平台合作伙伴权益', tone: 'success', group: '用户、商家与权益' },
  撤销平台合作伙伴权益: { value: '撤销平台合作伙伴权益', label: '撤销平台合作伙伴权益', tone: 'warning', group: '用户、商家与权益' },
  暂停邀请码资格: { value: '暂停邀请码资格', label: '暂停邀请码资格', tone: 'warning', group: '用户、商家与权益' },
  恢复邀请码资格: { value: '恢复邀请码资格', label: '恢复邀请码资格', tone: 'success', group: '用户、商家与权益' },
  作废未发奖励: { value: '作废未发奖励', label: '作废未发奖励', tone: 'danger', group: '用户、商家与权益' },

  // 订单、结算与交付
  仲裁退款: { value: '仲裁退款', label: '仲裁退款', tone: 'warning', group: '订单、结算与交付' },
  仲裁关闭: { value: '仲裁关闭', label: '仲裁关闭', tone: 'danger', group: '订单、结算与交付' },
  批量结算: { value: '批量结算', label: '批量结算', tone: 'success', group: '订单、结算与交付' },
  吊销交付文件: { value: '吊销交付文件', label: '吊销交付文件', tone: 'danger', group: '订单、结算与交付' },

  // 推广与精选
  安排平台精选: { value: '安排平台精选', label: '安排平台精选', tone: 'success', group: '推广与精选' },
  修改平台精选: { value: '修改平台精选', label: '修改平台精选', tone: 'info', group: '推广与精选' },
  撤销平台精选: { value: '撤销平台精选', label: '撤销平台精选', tone: 'warning', group: '推广与精选' },
  创建推广套餐: { value: '创建推广套餐', label: '创建推广套餐', tone: 'success', group: '推广与精选' },
  更新推广套餐: { value: '更新推广套餐', label: '更新推广套餐', tone: 'info', group: '推广与精选' },
  批准推广活动并扣款: { value: '批准推广活动并扣款', label: '批准推广活动并扣款', tone: 'success', group: '推广与精选' },
  '批准推广活动（余额不足）': { value: '批准推广活动（余额不足）', label: '批准推广活动（余额不足）', tone: 'warning', group: '推广与精选' },
  拒绝推广活动: { value: '拒绝推广活动', label: '拒绝推广活动', tone: 'danger', group: '推广与精选' },
  暂停推广活动: { value: '暂停推广活动', label: '暂停推广活动', tone: 'warning', group: '推广与精选' },
  恢复推广活动: { value: '恢复推广活动', label: '恢复推广活动', tone: 'success', group: '推广与精选' },
  推广活动退款调整: { value: '推广活动退款调整', label: '推广活动退款调整', tone: 'info', group: '推广与精选' },
  '推广活动退款调整（不退）': { value: '推广活动退款调整（不退）', label: '推广活动退款调整（不退）', tone: 'info', group: '推广与精选' },
  取消推广活动: { value: '取消推广活动', label: '取消推广活动', tone: 'warning', group: '推广与精选' },
  '取消推广活动（全额退款）': { value: '取消推广活动（全额退款）', label: '取消推广活动（全额退款）', tone: 'warning', group: '推广与精选' },
  手动重算排名: { value: '手动重算排名', label: '手动重算排名', tone: 'info', group: '推广与精选' },

  // 存储与外部交付
  创建存储配置: { value: '创建存储配置', label: '创建存储配置', tone: 'success', group: '存储与外部交付' },
  更新存储配置: { value: '更新存储配置', label: '更新存储配置', tone: 'info', group: '存储与外部交付' },
  测试存储配置: { value: '测试存储配置', label: '测试存储配置', tone: 'info', group: '存储与外部交付' },
  激活存储配置: { value: '激活存储配置', label: '激活存储配置', tone: 'success', group: '存储与外部交付' },
  回滚存储配置: { value: '回滚存储配置', label: '回滚存储配置', tone: 'warning', group: '存储与外部交付' },
  禁用存储配置: { value: '禁用存储配置', label: '禁用存储配置', tone: 'danger', group: '存储与外部交付' },
  同步Faka订阅到期: { value: '同步Faka订阅到期', label: '同步外部平台订阅到期', tone: 'info', group: '存储与外部交付' },
  重试Faka开通: { value: '重试Faka开通', label: '重试外部平台开通', tone: 'info', group: '存储与外部交付' },
  强制撤销Xboard订阅: { value: '强制撤销Xboard订阅', label: '强制撤销外部平台订阅', tone: 'danger', group: '存储与外部交付' },

  // 公告
  创建公告: { value: '创建公告', label: '创建公告', tone: 'success', group: '公告' },
  更新公告: { value: '更新公告', label: '更新公告', tone: 'info', group: '公告' },
  删除公告: { value: '删除公告', label: '删除公告', tone: 'danger', group: '公告' },

  // 稳定代码型动作
  'value_policy.create': { value: 'value_policy.create', label: '创建价值策略', tone: 'info', group: '价值策略与支付充值' },
  'value_policy.approve': { value: 'value_policy.approve', label: '审核价值策略', tone: 'success', group: '价值策略与支付充值' },
  'value_policy.schedule': { value: 'value_policy.schedule', label: '排期价值策略', tone: 'info', group: '价值策略与支付充值' },
  'value_policy.activate': { value: 'value_policy.activate', label: '启用价值策略', tone: 'success', group: '价值策略与支付充值' },
  'value_policy.retire': { value: 'value_policy.retire', label: '停用价值策略', tone: 'warning', group: '价值策略与支付充值' },
  'payment.event.retry': { value: 'payment.event.retry', label: '重试支付事件', tone: 'info', group: '价值策略与支付充值' },
  'payment.order.reconcile': { value: 'payment.order.reconcile', label: '核对充值订单', tone: 'info', group: '价值策略与支付充值' },
  'payment.order.refund': { value: 'payment.order.refund', label: '发起充值退款', tone: 'warning', group: '价值策略与支付充值' },
  'payment.admin_sandbox.confirm': { value: 'payment.admin_sandbox.confirm', label: '确认沙箱支付', tone: 'info', group: '价值策略与支付充值' },
  'payment.recon.create': { value: 'payment.recon.create', label: '创建对账任务', tone: 'info', group: '价值策略与支付充值' },
  'payment.recon.rerun': { value: 'payment.recon.rerun', label: '重跑对账任务', tone: 'warning', group: '价值策略与支付充值' },
  'payment.dispute.resolve': { value: 'payment.dispute.resolve', label: '解决支付争议', tone: 'success', group: '价值策略与支付充值' },
  'payment.recovery_case.close': { value: 'payment.recovery_case.close', label: '关闭支付恢复案例', tone: 'info', group: '价值策略与支付充值' },
  'recharge.price_policy.create': { value: 'recharge.price_policy.create', label: '创建充值价格策略', tone: 'info', group: '价值策略与支付充值' },
  'recharge.price_policy.patch': { value: 'recharge.price_policy.patch', label: '更新充值价格策略', tone: 'info', group: '价值策略与支付充值' },
  'recharge.price_policy.activate': { value: 'recharge.price_policy.activate', label: '启用充值价格策略', tone: 'success', group: '价值策略与支付充值' },
}

export const ADMIN_AUDIT_TARGET_REGISTRY: Record<string, AuditTargetRegistryItem> = {
  systemConfig: { value: 'systemConfig', label: '系统配置' },
  categoryApplication: { value: 'categoryApplication', label: '分类申请' },
  productCategory: { value: 'productCategory', label: '商品分类' },
  product: { value: 'product', label: '商品' },
  offer: { value: 'offer', label: '商品规格' },
  review: { value: 'review', label: '评价' },
  user: { value: 'user', label: '用户' },
  merchant: { value: 'merchant', label: '商家' },
  merchant_entitlement: { value: 'merchant_entitlement', label: '商家权益' },
  order: { value: 'order', label: '订单' },
  settlement: { value: 'settlement', label: '结算' },
  announcement: { value: 'announcement', label: '公告' },
  deliveryFile: { value: 'deliveryFile', label: '交付文件' },
  editorial_feature: { value: 'editorial_feature', label: '平台精选' },
  promotion_package: { value: 'promotion_package', label: '推广套餐' },
  promotion_campaign: { value: 'promotion_campaign', label: '推广活动' },
  merchandising_run: { value: 'merchandising_run', label: '排名任务' },
  storage_provider: { value: 'storage_provider', label: '存储配置' },
  faka_bridge_task: { value: 'faka_bridge_task', label: '外部交付任务' },
  user_referral: { value: 'user_referral', label: '用户邀请' },
  growthReward: { value: 'growthReward', label: '成长奖励' },
  portable_backup: { value: 'portable_backup', label: '可移植备份' },
  mailDelivery: { value: 'mailDelivery', label: '邮件投递' },
  ValuePolicy: { value: 'ValuePolicy', label: '价值策略' },
  PaymentEvent: { value: 'PaymentEvent', label: '支付事件' },
  RechargeOrder: { value: 'RechargeOrder', label: '充值订单' },
  RechargePricePolicy: { value: 'RechargePricePolicy', label: '充值价格策略' },
  ReconciliationRun: { value: 'ReconciliationRun', label: '对账任务' },
  PaymentDispute: { value: 'PaymentDispute', label: '支付争议' },
  PaymentRecoveryCase: { value: 'PaymentRecoveryCase', label: '支付恢复案例' },
}

export interface AdminAuditActionVisual {
  label: string
  tone: AuditTone
}

/**
 * Returns the localized visual display for an audit action.
 * Unknown actions safely fall back to neutral '其他操作'.
 */
export function adminAuditActionVisual(value: string | null | undefined): AdminAuditActionVisual {
  if (!value) {
    return { label: '其他操作', tone: 'neutral' }
  }
  const item = ADMIN_AUDIT_ACTION_REGISTRY[value]
  if (item) {
    return { label: item.label, tone: item.tone }
  }
  return { label: '其他操作', tone: 'neutral' }
}

/**
 * Returns the localized label for an audit targetType.
 * Null/empty falls back to '无特定对象', unknown falls back to '其他对象'.
 */
export function adminAuditTargetLabel(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') {
    return '无特定对象'
  }
  const item = ADMIN_AUDIT_TARGET_REGISTRY[value]
  if (item) {
    return item.label
  }
  return '其他对象'
}

export interface AuditActionGroupOption {
  group: string
  options: Array<{ value: string; label: string }>
}

/** Grouped actions for native <optgroup> dropdowns */
export const ADMIN_AUDIT_ACTION_GROUPS: AuditActionGroupOption[] = (() => {
  const groupMap = new Map<string, Array<{ value: string; label: string }>>()
  for (const item of Object.values(ADMIN_AUDIT_ACTION_REGISTRY)) {
    if (!groupMap.has(item.group)) {
      groupMap.set(item.group, [])
    }
    groupMap.get(item.group)!.push({ value: item.value, label: item.label })
  }
  return Array.from(groupMap.entries()).map(([group, options]) => ({
    group,
    options,
  }))
})()

/** Target options for select dropdown */
export const ADMIN_AUDIT_TARGET_OPTIONS: Array<{ value: string; label: string }> = Object.values(
  ADMIN_AUDIT_TARGET_REGISTRY
).map((item) => ({ value: item.value, label: item.label }))

export function auditToneBadgeClass(tone: AuditTone): string {
  switch (tone) {
    case 'success':
      return 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800'
    case 'info':
      return 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/40 dark:text-blue-300 dark:border-blue-800'
    case 'warning':
      return 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-800'
    case 'danger':
      return 'bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:border-rose-800'
    case 'neutral':
    default:
      return 'bg-zinc-100 text-zinc-700 border-zinc-200 dark:bg-zinc-800/60 dark:text-zinc-300 dark:border-zinc-700'
  }
}
