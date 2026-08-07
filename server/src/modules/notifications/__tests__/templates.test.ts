import { describe, expect, it } from 'vitest'
import { isSensitivePayloadKey, renderNotification } from '../templates.js'

describe('renderNotification templates', () => {
  const base = {
    orderId: 42,
    productName: 'ChatGPT Plus 月卡',
    offerName: '美区',
    deliveryMode: 'manual_service',
    merchantId: 7,
  }

  it('renders order.created_merchant', () => {
    const t = renderNotification('order.created_merchant', base)
    expect(t.title).toBe('新的待处理订单')
    expect(t.body).toContain('ChatGPT Plus 月卡')
    expect(t.body).toContain('美区')
    expect(t.deeplink).toBe('/merchant/orders/42')
    expect(t.category).toBe('order')
    expect(t.payload).toMatchObject({ orderId: 42, productName: 'ChatGPT Plus 月卡' })
    expect(t.payload).not.toHaveProperty('content')
  })

  it('renders order.processing_buyer', () => {
    const t = renderNotification('order.processing_buyer', base)
    expect(t.title).toBe('订单处理中')
    expect(t.deeplink).toBe('/orders?focus=42')
  })

  it('renders manual delivered copy', () => {
    const t = renderNotification('order.delivered_buyer', { ...base, deliveryKind: 'manual' })
    expect(t.title).toBe('订单已发货')
    expect(t.body).toContain('点击查看内容')
    expect(t.deeplink).toBe('/orders?focus=42')
  })

  it('renders instant delivered weak copy', () => {
    const t = renderNotification('order.delivered_buyer', {
      ...base,
      deliveryMode: 'instant_inventory',
      deliveryKind: 'instant',
    })
    expect(t.title).toBe('订单已交付')
    expect(t.body).toContain('可在订单中查看')
  })

  it('renders faka delivered copy', () => {
    const t = renderNotification('order.delivered_buyer', { ...base, deliveryKind: 'faka' })
    expect(t.title).toBe('订阅已开通')
    expect(t.body).toContain('已开通成功')
  })

  it('renders disputed buyer/merchant with role deeplinks', () => {
    const buyer = renderNotification('order.disputed_buyer', base)
    const merchant = renderNotification('order.disputed_merchant', base)
    expect(buyer.title).toBe('订单进入争议')
    expect(buyer.deeplink).toBe('/orders?focus=42')
    expect(merchant.deeplink).toBe('/merchant/orders/42')
  })

  it('renders refunded templates', () => {
    const t = renderNotification('order.refunded_buyer', base)
    expect(t.title).toBe('订单已退款')
    expect(t.body).toContain('#42')
  })

  it('renders dispute_resolved and closed', () => {
    expect(renderNotification('order.dispute_resolved_buyer', base).title).toBe('争议已处理')
    expect(renderNotification('order.closed_buyer', base).title).toBe('订单已完成')
  })

  it('keeps HTML/Markdown characters as plain text (no stripping of brackets)', () => {
    const t = renderNotification('order.created_merchant', {
      ...base,
      productName: '<b>evil</b> **bold**',
    })
    expect(t.body).toContain('<b>evil</b>')
    expect(t.body).toContain('**bold**')
    expect(t.payload.productName).toBe('<b>evil</b> **bold**')
  })

  it('payload never includes image/file/content keys', () => {
    const t = renderNotification('order.delivered_buyer', base)
    for (const key of Object.keys(t.payload)) {
      expect(isSensitivePayloadKey(key)).toBe(false)
    }
    expect(t.payload).not.toHaveProperty('content')
    expect(t.payload).not.toHaveProperty('image')
    expect(t.payload).not.toHaveProperty('file')
  })

  it('rejects absolute/external deeplink construction via orderId only relative paths', () => {
    const t = renderNotification('order.delivered_buyer', base)
    expect(t.deeplink.startsWith('/')).toBe(true)
    expect(t.deeplink).not.toMatch(/^https?:/)
  })

  it('throws on unknown eventType', () => {
    expect(() => renderNotification('order.unknown_event', base)).toThrow(/Unknown notification/)
  })
})
