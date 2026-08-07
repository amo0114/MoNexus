/**
 * SPEC-NOTIFY-001 Phase 1 notification templates.
 * Pure-text title/body + relative deeplink only (NTF-12). No HTML/Markdown/images/attachments.
 */

export type NotificationLevel = 'info' | 'success' | 'warning' | 'critical'

export type NotificationTemplate = {
  title: string
  body: string
  payload: Record<string, unknown>
  deeplink: string
  level: NotificationLevel
  category: string
}

export type NotificationRenderContext = {
  orderId: number
  productName?: string | null
  offerName?: string | null
  deliveryMode?: string | null
  merchantId?: number | null
  /** instant | manual | faka | auto — selects delivered copy variant */
  deliveryKind?: 'instant' | 'manual' | 'faka' | 'auto' | string
}

const SENSITIVE_PAYLOAD_KEYS = new Set([
  'content',
  'deliveryContent',
  'secret',
  'webhookSecret',
  'password',
  'token',
  'cardCode',
  'card_code',
  'inventoryContent',
  'file',
  'image',
  'imageUrl',
  'attachment',
  'html',
  'markdown',
])

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max - 1)}…`
}

/** Strip control chars; keep as plain text (HTML angle brackets stay as text). */
function plainText(value: unknown, max: number): string {
  const raw = value == null ? '' : String(value)
  const cleaned = raw.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim()
  return truncate(cleaned, max)
}

function productLabel(ctx: NotificationRenderContext): string {
  const name = plainText(ctx.productName, 80) || '商品'
  const offer = plainText(ctx.offerName, 40)
  return offer ? `${name}（${offer}）` : name
}

function safePayload(ctx: NotificationRenderContext): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    orderId: ctx.orderId,
  }
  if (ctx.productName != null) payload.productName = plainText(ctx.productName, 100)
  if (ctx.offerName != null) payload.offerName = plainText(ctx.offerName, 80)
  if (ctx.deliveryMode != null) payload.deliveryMode = plainText(ctx.deliveryMode, 40)
  if (ctx.merchantId != null) payload.merchantId = ctx.merchantId
  if (ctx.deliveryKind != null) payload.deliveryKind = plainText(ctx.deliveryKind, 20)

  for (const key of Object.keys(payload)) {
    if (SENSITIVE_PAYLOAD_KEYS.has(key)) {
      delete payload[key]
    }
  }
  return payload
}

function assertRelativeDeeplink(path: string): string {
  if (!path.startsWith('/') || path.startsWith('//')) {
    throw new Error(`Invalid deeplink (must be relative frontend path): ${path}`)
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(path) || path.toLowerCase().includes('javascript:')) {
    throw new Error(`Invalid deeplink scheme: ${path}`)
  }
  return path
}

function buyerOrderLink(orderId: number): string {
  return assertRelativeDeeplink(`/orders?focus=${orderId}`)
}

function merchantOrderLink(orderId: number): string {
  return assertRelativeDeeplink(`/merchant/orders/${orderId}`)
}

/**
 * Render a Phase 1 notification template. Unknown eventType throws.
 * Title/body are always plain text; payload never includes delivery secrets.
 */
export function renderNotification(
  eventType: string,
  context: NotificationRenderContext,
): NotificationTemplate {
  const orderId = context.orderId
  if (!Number.isInteger(orderId) || orderId <= 0) {
    throw new Error('renderNotification requires a positive orderId')
  }

  const label = productLabel(context)
  const payload = safePayload(context)
  const category = 'order'

  switch (eventType) {
    case 'order.created_merchant':
      return {
        title: '新的待处理订单',
        body: `买家兑换了「${label}」，请尽快处理`,
        payload,
        deeplink: merchantOrderLink(orderId),
        level: 'info',
        category,
      }

    case 'order.processing_buyer':
      return {
        title: '订单处理中',
        body: `商家正在处理「${label}」订单`,
        payload,
        deeplink: buyerOrderLink(orderId),
        level: 'info',
        category,
      }

    case 'order.delivered_buyer': {
      const kind = context.deliveryKind ?? (
        context.deliveryMode === 'instant_inventory' || context.deliveryMode === 'instant_fixed'
          ? 'instant'
          : 'manual'
      )
      if (kind === 'instant') {
        return {
          title: '订单已交付',
          body: `「${label}」已交付，可在订单中查看`,
          payload,
          deeplink: buyerOrderLink(orderId),
          level: 'success',
          category,
        }
      }
      if (kind === 'faka' || kind === 'auto') {
        return {
          title: '订阅已开通',
          body: `「${label}」已开通成功`,
          payload,
          deeplink: buyerOrderLink(orderId),
          level: 'success',
          category,
        }
      }
      return {
        title: '订单已发货',
        body: `「${label}」已交付，点击查看内容`,
        payload,
        deeplink: buyerOrderLink(orderId),
        level: 'success',
        category,
      }
    }

    case 'order.disputed_buyer':
    case 'order.disputed_merchant':
      return {
        title: '订单进入争议',
        body: `订单 #${orderId} 状态更新，请查看`,
        payload,
        deeplink: eventType.endsWith('_merchant') ? merchantOrderLink(orderId) : buyerOrderLink(orderId),
        level: 'warning',
        category,
      }

    case 'order.refunded_buyer':
    case 'order.refunded_merchant':
      return {
        title: '订单已退款',
        body: `订单 #${orderId} 已退款，积分已返还`,
        payload,
        deeplink: eventType.endsWith('_merchant') ? merchantOrderLink(orderId) : buyerOrderLink(orderId),
        level: 'info',
        category,
      }

    case 'order.dispute_resolved_buyer':
    case 'order.dispute_resolved_merchant':
      return {
        title: '争议已处理',
        body: `订单 #${orderId} 的争议已有结果，请查看`,
        payload,
        deeplink: eventType.endsWith('_merchant') ? merchantOrderLink(orderId) : buyerOrderLink(orderId),
        level: 'info',
        category,
      }

    case 'order.closed_buyer':
      return {
        title: '订单已完成',
        body: `订单 #${orderId}「${label}」已关闭`,
        payload,
        deeplink: buyerOrderLink(orderId),
        level: 'info',
        category,
      }

    default:
      throw new Error(`Unknown notification eventType: ${eventType}`)
  }
}

export function isSensitivePayloadKey(key: string): boolean {
  return SENSITIVE_PAYLOAD_KEYS.has(key)
}
