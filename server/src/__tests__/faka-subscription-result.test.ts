import { describe, expect, it } from 'vitest'
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
    expect(payload.structuredContent.values.trafficBefore).toContain('剩余')
    expect(payload.structuredContent.values.trafficAfter).toContain('剩余')
  })
})
