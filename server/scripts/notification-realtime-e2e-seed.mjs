#!/usr/bin/env node
/**
 * SPEC-NOTIFY-RT-001 (T-QA-003) — isolated real-stack E2E seed.
 *
 * Every invocation creates fresh actors and products. Optional scenarios add
 * only the data needed by the corresponding browser AC:
 *   base         common merchant, buyer A/B, manual + instant offers
 *   pagination   base + 45 order notifications + one excluded system item
 *   announcement base + one published acknowledgement-required announcement
 *
 * The script is hard-wired to the dedicated disposable realtime database.
 */
import { randomUUID } from 'node:crypto'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { prisma } from '../src/lib/prisma.js'
import { config } from '../src/config/index.js'

const databaseUrl = process.env.DATABASE_URL ?? ''
let databaseName = ''
try {
  databaseName = new URL(databaseUrl).pathname.replace(/^\//, '')
} catch {
  // The redacted error below deliberately does not echo the URL.
}
if (databaseName !== 'monexus_test_notification_realtime') {
  throw new Error('notification realtime E2E seed requires the dedicated database')
}

const scenario = process.env.RT_E2E_SCENARIO ?? 'base'
if (!['base', 'pagination', 'announcement'].includes(scenario)) {
  throw new Error(`unsupported RT_E2E_SCENARIO: ${scenario}`)
}

// Announcements are role-wide rather than user-targeted. Archive only this
// script's old fixtures so a crashed/previous run cannot change a later test's
// bell baseline; no application or unrelated test data is touched.
await prisma.announcement.updateMany({
  where: { title: { startsWith: '必须确认公告-' }, status: 'published' },
  data: { status: 'archived' },
})

const uniq = `${Date.now()}-${randomUUID().slice(0, 8)}`
const password = 'pass123'
const hashed = await bcrypt.hash(password, 10)
const merchantEmail = `rt-e2e-m-${uniq}@test.local`
const buyerEmail = `rt-e2e-a-${uniq}@test.local`
const buyerBEmail = `rt-e2e-b-${uniq}@test.local`

const merchantUser = await prisma.user.create({
  data: {
    email: merchantEmail,
    password: hashed,
    role: 'merchant',
    nickname: `实时商家-${uniq.slice(-4)}`,
  },
})
const merchant = await prisma.merchant.create({
  data: {
    userId: merchantUser.id,
    name: `实时E2E商家-${uniq.slice(-4)}`,
    status: 'active',
    commissionRate: 0.1,
    contactEmail: merchantEmail,
    approvedAt: new Date(),
  },
})

const manualProduct = await prisma.product.create({
  data: {
    name: `实时人工商品-${uniq}`,
    description: 'manual order fixture',
    type: '网络节点',
    price: 100,
    status: 'active',
    stock: 100,
    deliveryMode: 'manual_service',
    stockMode: 'limited',
    merchantId: merchant.id,
  },
})
const manualOffer = await prisma.offer.create({
  data: {
    productId: manualProduct.id,
    name: '人工服务',
    isDefault: true,
    price: 100,
    stock: 100,
    stockMode: 'limited',
    deliveryMode: 'manual_service',
  },
})

const instantSecret = `RT-INSTANT-SECRET-${uniq}`
const instantProduct = await prisma.product.create({
  data: {
    name: `实时即时商品-${uniq}`,
    description: 'instant fixed fixture',
    type: '邀请码',
    price: 30,
    status: 'active',
    stock: 0,
    deliveryMode: 'instant_fixed',
    stockMode: 'unlimited',
    fixedContent: instantSecret,
    fixedContentType: 'text',
    merchantId: merchant.id,
  },
})
const instantOffer = await prisma.offer.create({
  data: {
    productId: instantProduct.id,
    name: '即时固定内容',
    isDefault: true,
    price: 30,
    stock: 0,
    stockMode: 'unlimited',
    deliveryMode: 'instant_fixed',
    fixedContent: instantSecret,
    fixedContentType: 'text',
  },
})

const buyer = await prisma.user.create({
  data: { email: buyerEmail, password: hashed, role: 'user', nickname: `实时买家A-${uniq.slice(-4)}` },
})
const buyerB = await prisma.user.create({
  data: { email: buyerBEmail, password: hashed, role: 'user', nickname: `实时买家B-${uniq.slice(-4)}` },
})
await prisma.pointAccount.createMany({
  data: [
    { userId: buyer.id, balance: 100000 },
    { userId: buyerB.id, balance: 100000 },
  ],
})

let historyOrderIds = []
let systemNotificationId = null
if (scenario === 'pagination') {
  const historyPrefix = `rt-page-${uniq}`
  await prisma.notification.createMany({
    data: Array.from({ length: 45 }, (_, index) => ({
      recipientUserId: buyer.id,
      recipientRole: 'user',
      eventType: 'order.history_fixture',
      category: 'order',
      title: `历史订单消息-${String(index + 1).padStart(2, '0')}`,
      body: `分页历史 fixture ${index + 1}`,
      payload: { fixture: 'pagination', ordinal: index + 1 },
      deeplink: '/notifications',
      level: 'info',
      status: 'unread',
      dedupeKey: `${historyPrefix}:order:${index + 1}`,
    })),
  })
  const system = await prisma.notification.create({
    data: {
      recipientUserId: buyer.id,
      recipientRole: 'user',
      eventType: 'system.history_fixture',
      category: 'system',
      title: '系统分类排除项',
      body: 'order filter 中不得出现',
      payload: { fixture: 'pagination-system' },
      deeplink: '/notifications',
      level: 'info',
      status: 'unread',
      dedupeKey: `${historyPrefix}:system`,
    },
  })
  systemNotificationId = system.id
  historyOrderIds = (await prisma.notification.findMany({
    where: { recipientUserId: buyer.id, dedupeKey: { startsWith: `${historyPrefix}:order:` } },
    select: { id: true },
    orderBy: { id: 'desc' },
  })).map((item) => item.id)
}

let announcementId = null
let announcementTitle = null
if (scenario === 'announcement') {
  announcementTitle = `必须确认公告-${uniq}`
  const announcement = await prisma.announcement.create({
    data: {
      title: announcementTitle,
      content: '事务消息到达不能改变本公告的确认语义。',
      audience: 'user',
      priority: 100,
      presentation: 'acknowledgement_required',
      version: 1,
      startsAt: new Date(Date.now() - 60_000),
      status: 'published',
      createdBy: merchantUser.id,
    },
  })
  announcementId = announcement.id
}

const sign = (userId, role) => jwt.sign(
  { userId, role },
  config.jwtSecret,
  { expiresIn: '15m' },
)

console.log(JSON.stringify({
  scenario,
  password,
  merchantUserId: merchantUser.id,
  merchantEmail,
  merchantNickname: merchantUser.nickname,
  merchantToken: sign(merchantUser.id, 'merchant'),
  buyerUserId: buyer.id,
  buyerEmail,
  buyerNickname: buyer.nickname,
  buyerToken: sign(buyer.id, 'user'),
  buyerBUserId: buyerB.id,
  buyerBEmail,
  buyerBNickname: buyerB.nickname,
  buyerBToken: sign(buyerB.id, 'user'),
  productId: manualProduct.id,
  offerId: manualOffer.id,
  productName: manualProduct.name,
  instantProductId: instantProduct.id,
  instantOfferId: instantOffer.id,
  instantProductName: instantProduct.name,
  instantSecret,
  historyOrderIds,
  systemNotificationId,
  announcementId,
  announcementTitle,
}))

await prisma.$disconnect()
