#!/usr/bin/env node
/**
 * Export static HTML/text previews for transactional mail templates.
 *
 * Usage (repo root):
 *   node scripts/preview-mail-templates.mjs
 *
 * Requires server dependencies (`server/node_modules/tsx`).
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { register } from '../server/node_modules/tsx/dist/esm/api/index.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const outDir = join(root, 'outputs', 'mail-previews')

register()

const { renderMail } = await import(
  pathToFileURL(join(root, 'server/src/lib/mailer/templates/index.ts')).href
)

const brand = {
  siteName: 'MoNexus',
  appBaseUrl: 'https://preview.local',
  logoUrl: 'https://preview.local/brand/ledger-knot/mark-black.png',
}

const samples = [
  {
    kind: 'email_verification',
    vars: {
      to: 'user@example.com',
      verifyUrl: 'https://preview.local/verify-email#token=demo',
      expiresHours: 24,
    },
  },
  {
    kind: 'password_reset',
    vars: {
      to: 'user@example.com',
      resetUrl: 'https://preview.local/reset-password/demo-token',
      expiresMinutes: 30,
    },
  },
  {
    kind: 'provision_email_otp',
    vars: { to: 'panel@example.com', code: '482913', expiresMinutes: 10 },
  },
  {
    kind: 'mail_delivery_test',
    vars: { to: 'ops@example.com', triggeredAtIso: new Date().toISOString() },
  },
  {
    kind: 'low_stock',
    vars: {
      to: 'merchant@example.com',
      productName: '示例商品',
      offerName: '月卡',
      available: 2,
      threshold: 5,
    },
  },
  {
    kind: 'sla_overdue',
    vars: {
      to: 'merchant@example.com',
      orderId: 1001,
      productLabel: '人工代办',
      deadlineLabel: '2026-08-05 18:00',
      waitDurationLabel: '5 小时',
    },
  },
  {
    kind: 'booking_reminder',
    vars: {
      to: 'buyer@example.com',
      orderId: 1002,
      productLabel: '预约咨询',
      bookingDay: '2026-08-06',
      role: 'buyer',
    },
  },
  {
    kind: 'subscription_expiring',
    vars: {
      to: 'buyer@example.com',
      orderId: 1003,
      productLabel: 'Pro 订阅',
      expiresAtLabel: '2026-08-12 00:00',
    },
  },
  {
    kind: 'subscription_expired',
    vars: {
      to: 'buyer@example.com',
      orderId: 1003,
      productLabel: 'Pro 订阅',
      expiresAtLabel: '2026-08-12 00:00',
    },
  },
  {
    kind: 'provision_degraded',
    vars: {
      to: 'merchant@example.com',
      orderId: 1004,
      productLabel: 'Xboard 套餐',
      errorCode: 'webhook_timeout',
    },
  },
]

await mkdir(outDir, { recursive: true })
for (const s of samples) {
  const msg = renderMail(s.kind, { ...s.vars, brand })
  await writeFile(join(outDir, `${s.kind}.html`), msg.html, 'utf8')
  await writeFile(join(outDir, `${s.kind}.txt`), msg.text, 'utf8')
  console.log(`wrote ${s.kind}  (${msg.subject})`)
}
console.log(`\nPreviews: ${outDir}`)
