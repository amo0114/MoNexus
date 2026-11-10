import { describe, expect, it } from 'vitest'
import { parseStoredStructuredContent } from '../lib/deliveryFields.js'
import {
  actionLabel,
  buildFakaDeliveryPayload,
  extractFakaSubscriptionResult,
  formatExpiryUnix,
  formatTrafficBytes,
} from '../lib/fakaBridge/subscriptionResult.js'

describe('formatTrafficBytes', () => {
  it('formats bytes to human units', () => {
    expect(formatTrafficBytes(0)).toBe('0 B')
    expect(formatTrafficBytes(1024)).toBe('1 KB')
    expect(formatTrafficBytes(1073741824)).toBe('1 GB')
    expect(formatTrafficBytes(100)).toBe('100 B')
    expect(formatTrafficBytes(100 * 1024 ** 3)).toBe('100 GB')
    expect(formatTrafficBytes(1000 * 1024 ** 3)).toBe('1000 GB')
    expect(formatTrafficBytes(1.5 * 1024 ** 3)).toBe('1.5 GB')
  })
})

describe('formatExpiryUnix', () => {
  it('shows long-term when null', () => {
    expect(formatExpiryUnix(null)).toContain('长期')
  })
  it('formats seconds as local datetime', () => {
    const s = formatExpiryUnix(1791244800)
    expect(s).toMatch(/2026-/)
  })
})

describe('extractFakaSubscriptionResult + buildFakaDeliveryPayload', () => {
  it('extracts nested subscription and builds renew summary', () => {
    const beforeExp = Math.floor(Date.now() / 1000) + 20 * 86400
    const afterExp = beforeExp + 30 * 86400
    const body = {
      success: true as const,
      trade_no: 'T1',
      status: 'completed',
      subscription: {
        action: 'renew',
        period: 'monthly',
        before: {
          expired_at: beforeExp,
          transfer_enable: 100 * 1024 ** 3,
          used: 10 * 1024 ** 3,
          remaining: 90 * 1024 ** 3,
        },
        after: {
          expired_at: afterExp,
          transfer_enable: 100 * 1024 ** 3,
          used: 10 * 1024 ** 3,
          remaining: 90 * 1024 ** 3,
        },
      },
    }
    const sub = extractFakaSubscriptionResult(body)
    expect(sub?.action).toBe('renew')
    expect(actionLabel(sub?.action)).toBe('续费成功')

    const payload = buildFakaDeliveryPayload({
      tradeNo: 'T1',
      email: 'a@example.com',
      panelUrl: 'https://v.uuwu.de',
      subscription: sub,
    })
    expect(payload.content).toContain('续费成功')
    expect(payload.content).toContain('续期前到期')
    expect(payload.content).toContain('当前到期')
    expect(payload.structuredContent.values.action).toBe('续费成功')
    expect(payload.structuredContent.values.expiredBefore).toBeTruthy()
    expect(payload.structuredContent.values.expiredAfter).toBeTruthy()
  })

  it('builds traffic pack before/after remaining', () => {
    const body = {
      success: true as const,
      trade_no: 'T2',
      status: 'completed',
      action: 'onetime',
      period: 'onetime',
      before: {
        expired_at: null,
        transfer_enable: 50 * 1024 ** 3,
        used: 40 * 1024 ** 3,
        remaining: 10 * 1024 ** 3,
      },
      after: {
        expired_at: null,
        transfer_enable: 100 * 1024 ** 3,
        used: 0,
        remaining: 100 * 1024 ** 3,
      },
    }
    const sub = extractFakaSubscriptionResult(body)
    const payload = buildFakaDeliveryPayload({
      tradeNo: 'T2',
      email: 'b@example.com',
      panelUrl: 'https://v.uuwu.de',
      subscription: sub,
    })
    expect(payload.content).toContain('流量包开通')
    expect(payload.content).toContain('购买前流量')
    expect(payload.content).toContain('购买后流量')
    expect(payload.content).toContain('总量 100 GB')
    expect(payload.structuredContent.values.trafficBefore).toContain('剩余')
    expect(payload.structuredContent.values.trafficAfter).toContain('剩余')
    expect(payload.structuredContent.values.trafficAfter).toBe('剩余 100 GB（总量 100 GB）')
  })

  it('delivers a masked subscription credential within the stored field contract', () => {
    const sub = extractFakaSubscriptionResult({ subscription: {
      action: 'renew', period: 'monthly', subscribe_url: 'https://subscription.example.test/api/subscribe?token=fixture',
      before: { expired_at: 1800000000, transfer_enable: 50 * 1024 ** 3 },
      after: { expired_at: 1802592000, transfer_enable: 100 * 1024 ** 3 },
    } })
    const payload = buildFakaDeliveryPayload({ tradeNo: 'T3', panelUrl: 'https://panel.example.test', subscription: sub })
    expect(payload.structuredContent.fields.find(field => field.key === 'subscribeUrl')?.sensitive).toBe(true)
    expect(parseStoredStructuredContent(payload.structuredContent)?.values.subscribeUrl).toBe(sub?.subscribe_url)
    expect(payload.content).toContain('复制订阅链接')
    expect(payload.content).not.toContain('忘记密码')
    expect(payload.content).not.toContain('https://panel.example.test')
  })

  it.each(['javascript:alert(1)', 'http://subscription.example.test/token', 'https://user:pass@example.test/', 'https://example.test/\nsecret'])('rejects unsafe subscription URL %s', value => {
    const sub = extractFakaSubscriptionResult({ action: 'new', subscribe_url: value })
    expect(sub?.subscribe_url).toBeNull()
    const payload = buildFakaDeliveryPayload({ tradeNo: 'T4', panelUrl: 'https://panel.example.test', subscription: sub })
    expect(payload.structuredContent.values.subscribeUrl).toBeUndefined()
    expect(payload.content).toContain('请勿重复购买')
  })
})
