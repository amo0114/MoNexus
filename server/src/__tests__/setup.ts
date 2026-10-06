import { beforeAll, afterAll, beforeEach } from 'vitest'
import { relative } from 'node:path'
import { __resetCacheForTests } from '../lib/cache.js'
import { prisma } from '../lib/prisma.js'
import { reportCommonTestTimings, timeTestOperation } from './commonTiming.js'

let profileFile = ''
let profileTests = 0

beforeAll(async () => {
  await timeTestOperation('database.connect', () => prisma.$connect())
})

afterAll(async () => {
  try {
    await timeTestOperation('database.disconnect', () => prisma.$disconnect())
  } finally {
    reportCommonTestTimings(profileFile, profileTests)
  }
})

beforeEach(async ({ task }) => {
  profileFile = relative(process.cwd(), task.file.filepath)
  profileTests += 1
  await timeTestOperation('reset.cache', () => __resetCacheForTests())
  await timeTestOperation('reset.truncate', () => prisma.$executeRawUnsafe(`TRUNCATE TABLE
    "AiGeneration",
    "TrafficEvent",
    "TrafficDailyVisitor",
    "TrafficAggregationState",
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
    "ProductShareLink",
    "ProductAssuranceGrant",
    "ProductAssuranceApplication",
    "Product",
    "Offer",
    "MerchantWebhookConfig",
    "Merchant",
    "PointAccount",
    "UserAgreementConsent",
    "StoredObject",
    "StorageProviderConfig",
    "User"
    RESTART IDENTITY CASCADE`))
  // SPEC-STORAGE-001：runtime 单行复位为「仅 env 底座」
  await timeTestOperation('reset.storageRuntime', () => prisma.storageRuntime.upsert({
    where: { id: 1 },
    create: { id: 1, activeConfigId: null, configVersion: 0 },
    update: { activeConfigId: null, configVersion: 0 },
  }).catch(() => {}))
})
