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
    "AbuseEvent",
    "AuthChallenge",
    "MfaRecoveryCode",
    "AdminLog",
    "AnnouncementReceipt",
    "Announcement",
    "Settlement",
    "IdempotencyRecord",
    "FakaBridgeTask",
    "FakaProvisionEmailSendBudget",
    "FakaProvisionEmailProof",
    "DeliveryRecord",
    "ProvisionTask",
    "Order",
    "InventoryLog",
    "InventoryItem",
    "LeaderboardEntry",
    "PointLog",
    "GrowthReward",
    "CheckinRecord",
    "InviteRelation",
    "Review",
    "RefreshToken",
    "PasswordResetToken",
    "EmailVerificationToken",
    "Product",
    "Offer",
    "MerchantWebhookConfig",
    "Merchant",
    "PointAccount",
    "User"
    RESTART IDENTITY CASCADE`)
})
