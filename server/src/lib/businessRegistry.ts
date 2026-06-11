export const businessRegistry = {
  productTypes: [
    {
      value: '网络节点',
      label: '网络节点',
      deliveryModes: ['instant_inventory', 'instant_fixed', 'manual_service'],
    },
    {
      value: '共享账号',
      label: '共享账号',
      deliveryModes: ['instant_inventory', 'instant_fixed', 'manual_service'],
    },
    {
      value: '充值卡密',
      label: '充值卡密',
      deliveryModes: ['instant_inventory', 'instant_fixed', 'manual_service'],
    },
    {
      value: '邀请码',
      label: '邀请码',
      deliveryModes: ['instant_inventory', 'instant_fixed', 'manual_service'],
    },
  ],
  deliveryModes: [
    {
      value: 'instant_inventory',
      label: '即时库存发货',
      tone: 'success',
    },
    {
      value: 'instant_fixed',
      label: '固定内容直发',
      tone: 'success',
    },
    {
      value: 'manual_service',
      label: '人工服务履约',
      tone: 'info',
    },
  ],
  orderStatuses: [
    {
      value: 'pending',
      label: '待处理',
      tone: 'warning',
    },
    {
      value: 'processing',
      label: '处理中',
      tone: 'info',
    },
    {
      value: 'delivered',
      label: '已交付',
      tone: 'success',
    },
    {
      value: 'disputed',
      label: '争议中',
      tone: 'danger',
    },
    {
      value: 'closed',
      label: '已关闭',
      tone: 'neutral',
    },
  ],
  settlementStatuses: [
    {
      value: 'pending',
      label: '待结算',
      tone: 'warning',
    },
    {
      value: 'settled',
      label: '已结算',
      tone: 'success',
    },
  ],
  memberTiers: [
    { value: 'bronze', label: '普通会员', tone: 'neutral' },
    { value: 'silver', label: '银卡', tone: 'info' },
    { value: 'gold', label: '金卡', tone: 'warning' },
    { value: 'platinum', label: '铂金', tone: 'success' },
  ],
  pagination: {
    defaultPageSize: 20,
    maxPageSize: 100,
  },
  inventory: {
    lowStockThreshold: 5,
  },
} as const
