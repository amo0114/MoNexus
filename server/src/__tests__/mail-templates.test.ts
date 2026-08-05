import { describe, expect, it } from 'vitest'
import { htmlEscape } from '../lib/mailer/templates/escape.js'
import { renderMail } from '../lib/mailer/templates/index.js'
import type { MailTemplateKind } from '../lib/mailer/templates/render.js'

const brand = {
  siteName: 'MoNexus',
  appBaseUrl: 'https://app.example.test',
  logoUrl: 'https://app.example.test/brand/ledger-knot/mark-black.png',
}

describe('htmlEscape', () => {
  it('escapes markup-sensitive characters', () => {
    expect(htmlEscape(`a<"'>b&c`)).toBe('a&lt;&quot;&#39;&gt;b&amp;c')
  })
})

describe('renderMail', () => {
  it('renders email verification with CTA and dual format', () => {
    const msg = renderMail('email_verification', {
      to: 'user@example.test',
      verifyUrl: 'https://app.example.test/verify-email#token=abc',
      expiresHours: 24,
      brand,
    })
    expect(msg.to).toBe('user@example.test')
    expect(msg.subject).toContain('邮箱验证')
    expect(msg.text).toContain('https://app.example.test/verify-email#token=abc')
    expect(msg.html).toContain('验证邮箱')
    expect(msg.html).toContain('href="https://app.example.test/verify-email#token=abc"')
    expect(msg.html).toContain(brand.logoUrl)
    // 墨韵：无紫色顶栏、logo 无矩形底
    expect(msg.html).toContain('#34507A')
    expect(msg.html).toContain('#3D7257')
    expect(msg.html).not.toContain('#6366F1')
    expect(msg.html).not.toMatch(/background-color:#6366F1/i)
    expect(msg.html).not.toMatch(/img[^>]*background-color:/i)
  })

  it('renders password reset', () => {
    const msg = renderMail('password_reset', {
      to: 'user@example.test',
      resetUrl: 'https://app.example.test/reset-password/raw-token',
      expiresMinutes: 30,
      brand,
    })
    expect(msg.subject).toContain('密码重置')
    expect(msg.text).toContain('reset-password/raw-token')
    expect(msg.html).toContain('重置密码')
  })

  it('renders provision OTP with code in text and html', () => {
    const msg = renderMail('provision_email_otp', {
      to: 'panel@example.test',
      code: '482913',
      expiresMinutes: 10,
      brand,
    })
    expect(msg.subject).toContain('开通邮箱验证码')
    expect(msg.text).toContain('482913')
    expect(msg.html).toContain('482913')
  })

  it('renders mail delivery test without business secrets in text', () => {
    const msg = renderMail('mail_delivery_test', {
      to: 'ops@example.test',
      triggeredAtIso: '2026-08-05T12:00:00.000Z',
      brand,
    })
    expect(msg.subject).toBe('MoNexus 邮件投递测试')
    expect(msg.text).not.toMatch(/https?:\/\//)
    expect(msg.text).toContain('2026-08-05T12:00:00.000Z')
    expect(msg.html).toBeTruthy()
  })

  it('escapes attacker-controlled product names in html', () => {
    const evil = `"><script>alert(1)</script>`
    const msg = renderMail('low_stock', {
      to: 'merchant@example.test',
      productName: evil,
      offerName: evil,
      available: 1,
      threshold: 3,
      brand,
    })
    expect(msg.html).not.toContain('<script')
    expect(msg.html).toContain('&lt;script&gt;')
    expect(msg.subject).toContain(evil)
  })

  it('renders detail fields as stacked label/value (not a side-by-side grid table)', () => {
    const msg = renderMail('low_stock', {
      to: 'merchant@example.test',
      productName: '示例商品',
      offerName: '月卡',
      available: 2,
      threshold: 5,
      brand,
    })
    // Stacked meta card: label and value are separate block-level lines.
    expect(msg.html).toContain('示例商品')
    expect(msg.html).toContain('月卡')
    expect(msg.html).toMatch(/font-size:12px[\s\S]*商品/)
    expect(msg.html).toMatch(/font-size:16px[\s\S]*示例商品/)
  })

  it('covers remaining business kinds with dual bodies', () => {
    const cases: Array<{ kind: MailTemplateKind; vars: Parameters<typeof renderMail>[1] }> = [
      {
        kind: 'sla_overdue',
        vars: {
          to: 'm@example.test',
          orderId: 42,
          productLabel: '人工服务',
          deadlineLabel: '2026-08-01 12:00',
          waitDurationLabel: '3 小时',
          brand,
        },
      },
      {
        kind: 'booking_reminder',
        vars: {
          to: 'b@example.test',
          orderId: 7,
          productLabel: '预约服务',
          bookingDay: '2026-08-06',
          role: 'buyer',
          brand,
        },
      },
      {
        kind: 'subscription_expiring',
        vars: {
          to: 'u@example.test',
          orderId: 9,
          productLabel: '月卡',
          expiresAtLabel: '2026-08-10 00:00',
          brand,
        },
      },
      {
        kind: 'subscription_expired',
        vars: {
          to: 'u@example.test',
          orderId: 9,
          productLabel: '月卡',
          expiresAtLabel: '2026-08-10 00:00',
          brand,
        },
      },
      {
        kind: 'provision_degraded',
        vars: {
          to: 'm@example.test',
          orderId: 11,
          productLabel: 'Xboard 套餐',
          errorCode: 'webhook_timeout',
          brand,
        },
      },
    ]

    for (const c of cases) {
      const msg = renderMail(c.kind as never, c.vars as never)
      expect(msg.subject.length).toBeGreaterThan(0)
      expect(msg.text.length).toBeGreaterThan(0)
      expect(msg.html?.length ?? 0).toBeGreaterThan(0)
      expect(msg.html).toContain('MoNexus')
    }
  })
})
