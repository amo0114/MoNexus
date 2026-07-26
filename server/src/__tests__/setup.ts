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
    "SecurityEvent",
    "AuthChallenge",
    "MfaRecoveryCode",
    "AdminLog",
    "AnnouncementReceipt",
    "Announcement",
    "Settlement",
    "IdempotencyRecord",
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
    "Offer",
    "Merchant",
    "PointAccount",
    "User"
    RESTART IDENTITY CASCADE`)
})
