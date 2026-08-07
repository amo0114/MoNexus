/**
 * Build buyer-facing delivery text + structured content from FakaBridge
 * before/after subscription snapshots (expiry + traffic).
 */
import type { StructuredDeliveryContent } from '../deliveryFields.js'
import type {
  FakaOrderPaidSuccess,
  FakaSubscriptionAction,
  FakaSubscriptionResult,
  FakaUserSubscriptionSnapshot,
} from './types.js'
import { parseFakaExpiredAt } from './expiredAt.js'

function asSnap(value: unknown): FakaUserSubscriptionSnapshot | null {
  if (value == null || typeof value !== 'object') return null
  const o = value as Record<string, unknown>
  const num = (k: string): number | undefined => {
    const v = o[k]
    if (typeof v === 'number' && Number.isFinite(v)) return v
    if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim())) return Number(v)
    return undefined
  }
  const transfer = num('transfer_enable') ?? 0
  const u = num('u') ?? 0
  const d = num('d') ?? 0
  const used = num('used') ?? Math.max(0, u + d)
  const remaining = num('remaining') ?? Math.max(0, transfer - used)
  const expiredRaw = o.expired_at
  let expired_at: number | null | undefined
  if (expiredRaw === null) expired_at = null
  else if (typeof expiredRaw === 'number' || typeof expiredRaw === 'string') {
    const dte = parseFakaExpiredAt(expiredRaw)
    expired_at = dte ? Math.floor(dte.getTime() / 1000) : null
  }
  return {
    expired_at: expired_at ?? null,
    transfer_enable: transfer,
    u,
    d,
    used,
    remaining,
    plan_id: num('plan_id') ?? null,
  }
}

/** Pull subscription block from paid/status body (flat or nested). */
export function extractFakaSubscriptionResult(body: unknown): FakaSubscriptionResult | null {
  if (body == null || typeof body !== 'object') return null
  const o = body as Record<string, unknown>
  const nested =
    o.subscription != null && typeof o.subscription === 'object'
      ? (o.subscription as Record<string, unknown>)
      : null

  const action =
    (typeof nested?.action === 'string' && nested.action) ||
    (typeof o.action === 'string' && o.action) ||
    null
  const period =
    (typeof nested?.period === 'string' && nested.period) ||
    (typeof o.period === 'string' && o.period) ||
    null
  const before = asSnap(nested?.before ?? o.before)
  const after = asSnap(nested?.after ?? o.after)
  if (!action && !period && !before && !after) return null
  return { action, period, before, after }
}

export function formatTrafficBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let n = bytes
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i += 1
  }
  // Prefer compact labels: 1 KB / 1.5 GB (drop trailing zeros).
  const digits = n >= 100 || i === 0 ? 0 : n >= 10 ? 1 : 2
  const raw = n.toFixed(digits)
  const trimmed = raw.replace(/\.?0+$/, '')
  return `${trimmed} ${units[i]}`
}

export function formatExpiryUnix(sec: number | null | undefined): string {
  if (sec == null || sec <= 0) return '长期 / 无时间限制'
  const d = new Date(sec * 1000)
  if (Number.isNaN(d.getTime())) return '—'
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function actionLabel(action: FakaSubscriptionAction | null | undefined): string {
  switch (action) {
    case 'new':
      return '新购开通'
    case 'renew':
      return '续费成功'
    case 'onetime':
      return '流量包开通'
    case 'reset_traffic':
      return '流量重置成功'
    default:
      return '订阅已开通'
  }
}

export function periodLabel(period: string | null | undefined): string {
  switch ((period ?? '').toLowerCase()) {
    case 'monthly':
      return '月付'
    case 'quarterly':
      return '季付'
    case 'half_yearly':
      return '半年付'
    case 'yearly':
      return '年付'
    case 'two_yearly':
      return '两年付'
    case 'three_yearly':
      return '三年付'
    case 'onetime':
      return '流量包'
    case 'reset_traffic':
      return '重置包'
    default:
      return period?.trim() || '—'
  }
}

/**
 * Human-readable delivery text + structured fields for SuccessModal / order detail.
 */
export function buildFakaDeliveryPayload(input: {
  tradeNo: string | null
  email?: string | null
  panelUrl: string
  subscription: FakaSubscriptionResult | null
}): { content: string; structuredContent: StructuredDeliveryContent } {
  const panel = input.panelUrl || 'https://v.uuwu.de'
  const no = input.tradeNo?.trim() || '(未知)'
  const mail = input.email?.trim() || '(开通邮箱见下单信息)'
  const sub = input.subscription
  const action = sub?.action ?? null
  const before = sub?.before ?? null
  const after = sub?.after ?? null
  const title = actionLabel(action)

  const lines: string[] = [
    title,
    `类型: ${periodLabel(sub?.period)}`,
    `订单号: ${no}`,
    `开通邮箱: ${mail}`,
    `面板: ${panel}`,
  ]

  const showExpiry =
    action === 'new' ||
    action === 'renew' ||
    (action !== 'reset_traffic' && action !== 'onetime') ||
    (after?.expired_at != null && after.expired_at > 0)

  if (action === 'renew' || action === 'new') {
    if (before && (action === 'renew' || (before.expired_at != null && before.expired_at > 0))) {
      lines.push(`续期前到期: ${formatExpiryUnix(before.expired_at)}`)
    }
    lines.push(`当前到期: ${formatExpiryUnix(after?.expired_at)}`)
  } else if (showExpiry && after) {
    lines.push(`当前到期: ${formatExpiryUnix(after.expired_at)}`)
  }

  const showTraffic =
    action === 'onetime' ||
    action === 'reset_traffic' ||
    (before != null && after != null && (before.transfer_enable !== after.transfer_enable || before.used !== after.used))

  if (showTraffic || action === 'onetime' || action === 'reset_traffic') {
    if (before) {
      lines.push(
        `购买前流量: 剩余 ${formatTrafficBytes(before.remaining)} / 总量 ${formatTrafficBytes(before.transfer_enable)}（已用 ${formatTrafficBytes(before.used)}）`
      )
    }
    if (after) {
      lines.push(
        `购买后流量: 剩余 ${formatTrafficBytes(after.remaining)} / 总量 ${formatTrafficBytes(after.transfer_enable)}（已用 ${formatTrafficBytes(after.used)}）`
      )
    }
  }

  lines.push('请使用上述邮箱登录面板（已有账号直接登录；新账号请用「忘记密码」设置密码）。')

  const fields: StructuredDeliveryContent['fields'] = [
    { key: 'action', label: '开通结果', sensitive: false },
    { key: 'period', label: '套餐周期', sensitive: false },
  ]
  const values: Record<string, string> = {
    action: title,
    period: periodLabel(sub?.period),
  }

  if (action === 'renew' || action === 'new') {
    if (before && (action === 'renew' || (before.expired_at != null && before.expired_at > 0))) {
      fields.push({ key: 'expiredBefore', label: '续期前到期', sensitive: false })
      values.expiredBefore = formatExpiryUnix(before.expired_at)
    }
    fields.push({ key: 'expiredAfter', label: action === 'renew' ? '续期后到期' : '订阅到期', sensitive: false })
    values.expiredAfter = formatExpiryUnix(after?.expired_at)
  } else if (after?.expired_at != null && after.expired_at > 0) {
    fields.push({ key: 'expiredAfter', label: '订阅到期', sensitive: false })
    values.expiredAfter = formatExpiryUnix(after.expired_at)
  }

  if (action === 'onetime' || action === 'reset_traffic' || showTraffic) {
    if (before) {
      fields.push({ key: 'trafficBefore', label: '购买前剩余流量', sensitive: false })
      values.trafficBefore = `剩余 ${formatTrafficBytes(before.remaining)}（总量 ${formatTrafficBytes(before.transfer_enable)}）`
    }
    if (after) {
      fields.push({ key: 'trafficAfter', label: '购买后剩余流量', sensitive: false })
      values.trafficAfter = `剩余 ${formatTrafficBytes(after.remaining)}（总量 ${formatTrafficBytes(after.transfer_enable)}）`
    }
  }

  fields.push(
    { key: 'tradeNo', label: 'Xboard 订单号', sensitive: false },
    { key: 'email', label: '开通邮箱', sensitive: false },
    { key: 'panel', label: '面板地址', sensitive: false }
  )
  values.tradeNo = no
  values.email = mail
  values.panel = panel

  return {
    content: lines.join('\n'),
    structuredContent: { fields, values },
  }
}

/** Prefer nested subscription from paid body, then flat fields. */
export function subscriptionFromPaidBody(body: FakaOrderPaidSuccess | null | undefined): FakaSubscriptionResult | null {
  return extractFakaSubscriptionResult(body)
}
