import { beforeAll, afterAll, beforeEach } from 'vitest'
import { __resetCacheForTests } from '../lib/cache.js'
import { prisma } from '../lib/prisma.js'

beforeAll(async () => {
  await prisma.$connect()
})

afterAll(async () => {
  await prisma.$disconnect()
})

beforeEach(async () => {
  await __resetCacheForTests()
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE
    "AdminLog",
    "Settlement",
    "DeliveryRecord",
    "Order",
    "InventoryLog",
    "InventoryItem",
    "PointLog",
    "CheckinRecord",
    "InviteRelation",
    "Review",
    "RefreshToken",
    "PasswordResetToken",
    "EmailVerificationToken",
    "Product",
    "Merchant",
    "PointAccount",
    "User"
    RESTART IDENTITY CASCADE`)
})
