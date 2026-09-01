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
    "RechargeIdempotencyRecord",
    "RechargeCreditTask",
    "RechargeLimitReservation",
    "RechargeLimitBucket",
    "ReconciliationItem",
    "ReconciliationRun",
    "AccountRestriction",
    "PaymentRecoveryCase",
    "PaymentDispute",
    "RechargeReversal",
    "PointHold",
    "RechargeRefund",
    "RechargeCredit",
    "PaymentEvent",
    "PaymentAttempt",
    "PaymentIntent",
    "RechargeOrder",
    "RechargeQuote",
    "RechargeSuggestedAmount",
    "RechargePricePolicy",
    "SecurityEvent",
    "AbuseEvent",
    "AuthChallenge",
    "MfaRecoveryCode",
    "AdminLog",
    "AnnouncementReceipt",
    "Announcement",
    "Notification",
    "Settlement",
    "IdempotencyRecord",
    "ExternalCatalogSyncIdempotency",
    "FakaBridgeTask",
    "FakaProvisionEmailSendBudget",
    "FakaProvisionEmailProof",
    "DeliveryRecord",
    "ProvisionTask",
    "OrderAgreementAcceptance",
    "OrderPricingSnapshot",
    "Order",
    "ValuePolicy",
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
    "InviteCode",
    "Product",
    "Offer",
    "MerchantWebhookConfig",
    "Merchant",
    "PointAccount",
    "UserAgreementConsent",
    "StoredObject",
    "StorageProviderConfig",
    "User"
    RESTART IDENTITY CASCADE`)
  // SPEC-STORAGE-001：runtime 单行复位为「仅 env 底座」
  await prisma.storageRuntime.upsert({
    where: { id: 1 },
    create: { id: 1, activeConfigId: null, configVersion: 0 },
    update: { activeConfigId: null, configVersion: 0 },
  }).catch(() => {})
})
