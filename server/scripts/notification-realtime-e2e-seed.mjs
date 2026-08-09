#!/usr/bin/env node
/**
 * SPEC-NOTIFY-RT-001 (T-QA-003) — E2E seed: creates a fresh merchant with a
 * manual-service product and a funded buyer, prints JSON for the Playwright
 * spec. Used only against the dedicated monexus_test_notification_realtime DB.
 */
import { prisma } from '../src/lib/prisma.js'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { config } from '../src/config/index.js'

const uniq = Date.now()
const merchantEmail = `rt-e2e-m-${uniq}@test.local`
const buyerEmail = `rt-e2e-b-${uniq}@test.local`

const hashed = await bcrypt.hash('pass123', 10)

const merchantUser = await prisma.user.create({
  data: { email: merchantEmail, password: hashed, role: 'merchant' },
})
const merchant = await prisma.merchant.create({
  data: {
    userId: merchantUser.id,
    name: '实时E2E商家',
    status: 'active',
    commissionRate: 0.1,
    contactEmail: merchantEmail,
    approvedAt: new Date(),
  },
})
const product = await prisma.product.create({
  data: {
    name: '实时E2E商品',
    description: 'manual order fixture',
    type: '网络节点',
    price: 100,
    status: 'active',
    stock: 5,
    merchantId: merchant.id,
  },
})
const offer = await prisma.offer.create({
  data: { productId: product.id, name: '人工服务', isDefault: true, price: 100, stock: 5, deliveryMode: 'manual_service' },
})
const buyer = await prisma.user.create({ data: { email: buyerEmail, password: hashed, role: 'user' } })
await prisma.pointAccount.create({ data: { userId: buyer.id, balance: 100000 } })

const merchantToken = jwt.sign({ userId: merchantUser.id, role: 'merchant' }, config.jwtSecret, { expiresIn: '15m' })
const buyerToken = jwt.sign({ userId: buyer.id, role: 'user' }, config.jwtSecret, { expiresIn: '15m' })

console.log(
  JSON.stringify({
    merchantUserId: merchantUser.id,
    merchantToken,
    buyerUserId: buyer.id,
    buyerToken,
    productId: product.id,
    offerId: offer.id,
  })
)

await prisma.$disconnect()
