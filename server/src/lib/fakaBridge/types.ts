/** Body fields for POST /plugin/faka-bridge/order-paid (before/after sign). */
export interface FakaOrderPaidRequest {
  order_no: string
  email: string
  sku: string
  /** Canonical Xboard period; default monthly. Named SKUs ignore this on plugin side. */
  period?: string
  /** Unix seconds; always send to enable plugin anti-replay window. */
  paid_at: number
  sign?: string
}

export interface FakaOrderPaidSuccess {
  success: true
  trade_no: string | null
  order_no?: string
  status: string
  message?: string
}

export interface FakaOrderPaidFailure {
  success: false
  error: string
}

export type FakaOrderPaidResponse = FakaOrderPaidSuccess | FakaOrderPaidFailure

export interface FakaOrderStatusSuccess {
  success: true
  order_no: string
  status: string
  trade_no: string | null
  created_at?: string
  completed_at?: string | null
  error_log?: string | null
}

export interface FakaOrderStatusFailure {
  success: false
  error: string
}

export type FakaOrderStatusResponse = FakaOrderStatusSuccess | FakaOrderStatusFailure

export interface FakaOrderRevokeSuccess {
  success: true
  order_no: string
  status: string
  trade_no: string | null
  expired_user: boolean
  message?: string
}

export interface FakaOrderRevokeFailure {
  success: false
  error: string
}

export type FakaOrderRevokeResponse = FakaOrderRevokeSuccess | FakaOrderRevokeFailure

export interface FakaPlanCapacitySuccess {
  success: true
  sku: string
  plan_id: number
  period?: string
  capacity_limit: number | null
  active_users: number
  /** null when capacity_limit is null (unlimited) */
  remaining: number | null
  /** plan show+sell and remaining allows new purchase */
  sellable: boolean
  show?: boolean
  sell?: boolean
}

export interface FakaPlanCapacityFailure {
  success: false
  error: string
}

export type FakaPlanCapacityResponse = FakaPlanCapacitySuccess | FakaPlanCapacityFailure

export interface FakaPlanCatalogPeriod {
  period: string
  price: number
  sku_alias: string
}

export interface FakaPlanCatalogItem {
  plan_id: number
  name: string
  /** Xboard 套餐介绍（HTML/纯文本），导入时写入商品图文 */
  content?: string | null
  show: boolean
  sell: boolean
  renew: boolean
  group_id: number | null
  transfer_enable: number
  capacity_limit: number | null
  active_users: number
  remaining: number | null
  periods: FakaPlanCatalogPeriod[]
  named_skus: Array<{ sku: string; period: string }>
}

export interface FakaPlanCatalogSuccess {
  success: true
  plans: FakaPlanCatalogItem[]
}

export type FakaPlanCatalogResponse = FakaPlanCatalogSuccess | FakaPlanCapacityFailure

/** Normalized result after HTTP + JSON parse (never throws for 4xx body). */
export interface FakaHttpResult<T> {
  ok: boolean
  httpStatus: number
  /** Desensitized machine code for logs / task.lastError */
  code: string
  body: T | null
  rawText: string
}

export type FakaTransport = (input: {
  method: 'GET' | 'POST'
  url: string
  headers: Record<string, string>
  body?: string
  timeoutMs: number
}) => Promise<{ status: number; text: string }>
