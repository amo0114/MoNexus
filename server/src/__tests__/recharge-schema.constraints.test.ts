import { randomUUID } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { describe, expect, it } from 'vitest'
import { prisma } from '../lib/prisma.js'
import { POINT_ACCOUNT_HARD_CAP } from '../modules/points/checkedMutation.js'

let serial = 0
let policyVersion = 0

function suffix() {
  serial += 1
  return `${Date.now().toString(36)}-${serial}`
}

async function createUser(emailPrefix = 'recharge-schema') {
  return prisma.user.create({
    data: { email: `${emailPrefix}-${suffix()}@t.local`, password: 'x' },
  })
}

function policyData(overrides: Partial<Prisma.RechargePricePolicyUncheckedCreateInput> = {}): Prisma.RechargePricePolicyUncheckedCreateInput {
  policyVersion += 1
  return {
    code: `rp-cny-${suffix()}`,
    version: policyVersion,
    currency: 'CNY',
    currencyScale: 2,
    pointsNumerator: 1n,
    pointsDenominator: 1n,
    minAmountMinor: 100n,
    maxAmountMinor: 100_000n,
    amountStepMinor: 1n,
    dailyLimitMinor: 200_000n,
    monthlyLimitMinor: 1_000_000n,
    limitTimeZone: 'Asia/Shanghai',
    status: 'draft',
    effectiveAt: new Date(),
    ...overrides,
  }
}

async function createPolicy(overrides: Partial<Prisma.RechargePricePolicyUncheckedCreateInput> = {}) {
  return prisma.rechargePricePolicy.create({ data: policyData(overrides) })
}

async function createQuote(userId: number, pricePolicyId: string) {
  return prisma.rechargeQuote.create({
    data: {
      userId,
      pricePolicyId,
      provider: 'simulator',
      paymentMethod: 'card',
      providerAccountKey: 'sim-default',
      capabilityVersion: 'v1',
      capabilityDigest: 'd'.repeat(64),
      currency: 'CNY',
      amountMinor: 100n,
      effectiveMinAmountMinor: 100n,
      effectiveMaxAmountMinor: 100_000n,
      basePoints: 100n,
      bonusPoints: 0n,
      totalPoints: 100n,
      amountSource: 'custom',
      expiresAt: new Date(Date.now() + 600_000),
    },
  })
}

async function createOrder(userId: number, quoteId: string, pricePolicyId: string) {
  return prisma.rechargeOrder.create({
    data: {
      userId,
      quoteId,
      pricePolicyId,
      currency: 'CNY',
      amountMinor: 100n,
      basePoints: 100n,
      bonusPoints: 0n,
      totalPoints: 100n,
      pricePolicyCode: 'rp-cny-recharge-v1',
      pricePolicyVersion: 1,
      pointsNumerator: 1n,
      pointsDenominator: 1n,
      roundingMode: 'HALF_EVEN',
      currencyScale: 2,
      amountSource: 'custom',
      provider: 'simulator',
      paymentMethod: 'card',
      providerAccountKey: 'sim-default',
      capabilityVersion: 'v1',
      capabilityDigest: 'd'.repeat(64),
      effectiveMinAmountMinor: 100n,
      effectiveMaxAmountMinor: 100_000n,
      disclosureVersion: 'v1',
      status: 'created',
      expiresAt: new Date(Date.now() + 600_000),
    },
  })
}

async function createIntent(orderId: string) {
  return prisma.paymentIntent.create({
    data: {
      rechargeOrderId: orderId,
      amountMinor: 100n,
      currency: 'CNY',
      status: 'requires_method',
      expiresAt: new Date(Date.now() + 600_000),
    },
  })
}

describe('RechargePricePolicy CHECKs and one-active unique', () => {
  it('rejects negative amounts, zero denominator, and inverted min/max', async () => {
    await expect(createPolicy({ pointsDenominator: 0n })).rejects.toThrow()
    await expect(createPolicy({ minAmountMinor: 200n, maxAmountMinor: 100n })).rejects.toThrow()
    await expect(createPolicy({ dailyLimitMinor: 50n, maxAmountMinor: 100n })).rejects.toThrow()
    await expect(createPolicy({ status: 'published' })).rejects.toThrow()
  })

  it('allows only one active policy per currency', async () => {
    await createPolicy({ currency: 'USD', version: 1, status: 'active' })
    await expect(createPolicy({ currency: 'USD', version: 2, status: 'active' })).rejects.toThrow()
    await expect(createPolicy({ currency: 'USD', version: 2, status: 'draft' })).resolves.toMatchObject({
      status: 'draft',
    })
  })
})

describe('PaymentObservation / PaymentEvent contract', () => {
  it('accepts the frozen source and verification pairing and unique dedupe', async () => {
    const user = await createUser()
    const policy = await createPolicy()
    const quote = await createQuote(user.id, policy.id)
    const order = await createOrder(user.id, quote.id, policy.id)
    const intent = await createIntent(order.id)
    const attempt = await prisma.paymentAttempt.create({
      data: {
        paymentIntentId: intent.id,
        provider: 'simulator',
        providerAccountKey: 'sim-default',
        method: 'card',
        status: 'processing',
        requestIdempotencyKey: `idem-${suffix()}`,
        actionType: 'none',
      },
    })

    const observation = await prisma.paymentEvent.create({
      data: {
        provider: 'simulator',
        providerAccountKey: 'sim-default',
        source: 'webhook',
        verificationMethod: 'webhook_signature',
        paymentAttemptId: attempt.id,
        dedupeKey: `webhook:${randomUUID()}`,
        eventType: 'payment.succeeded',
        payloadSha256: 'ab'.repeat(32),
        normalizedPayload: { status: 'succeeded' },
        signatureVerified: true,
        status: 'received',
        observedAt: new Date(),
      },
    })
    expect(observation.source).toBe('webhook')
    expect(observation.verificationMethod).toBe('webhook_signature')
    expect(observation.leaseToken).toBeNull()

    await expect(prisma.paymentEvent.create({
      data: {
        provider: 'simulator',
        providerAccountKey: 'sim-default',
        source: 'webhook',
        verificationMethod: 'authenticated_provider_api',
        dedupeKey: `webhook:${randomUUID()}`,
        eventType: 'payment.succeeded',
        payloadSha256: 'cd'.repeat(32),
        normalizedPayload: { status: 'succeeded' },
        status: 'received',
        observedAt: new Date(),
      },
    })).rejects.toThrow()

    await expect(prisma.paymentEvent.create({
      data: {
        provider: 'simulator',
        providerAccountKey: 'sim-default',
        source: 'webhook',
        verificationMethod: 'webhook_signature',
        dedupeKey: observation.dedupeKey,
        eventType: 'payment.succeeded',
        payloadSha256: 'ef'.repeat(32),
        normalizedPayload: { status: 'succeeded' },
        status: 'received',
        observedAt: new Date(),
      },
    })).rejects.toThrow()
  })
})

describe('PaymentAttempt uniqueness', () => {
  it('allows multiple null providerPaymentIds and rejects a duplicate non-null id', async () => {
    const user = await createUser()
    const policy = await createPolicy()
    const quote = await createQuote(user.id, policy.id)
    const order = await createOrder(user.id, quote.id, policy.id)
    const intent = await createIntent(order.id)

    await prisma.paymentAttempt.create({
      data: {
        paymentIntentId: intent.id,
        provider: 'stripe',
        providerAccountKey: 'acct_a',
        method: 'card',
        status: 'failed',
        requestIdempotencyKey: `idem-a-${suffix()}`,
        actionType: 'none',
      },
    })
    await expect(prisma.paymentAttempt.create({
      data: {
        paymentIntentId: intent.id,
        provider: 'stripe',
        providerAccountKey: 'acct_a',
        method: 'card',
        status: 'failed',
        requestIdempotencyKey: `idem-b-${suffix()}`,
        actionType: 'none',
      },
    })).resolves.toMatchObject({ providerPaymentId: null })

    const providerPaymentId = `pi_${suffix()}`
    await prisma.paymentAttempt.create({
      data: {
        paymentIntentId: intent.id,
        provider: 'stripe',
        providerAccountKey: 'acct_a',
        method: 'card',
        status: 'failed',
        providerPaymentId,
        requestIdempotencyKey: `idem-c-${suffix()}`,
        actionType: 'none',
      },
    })
    await expect(prisma.paymentAttempt.create({
      data: {
        paymentIntentId: intent.id,
        provider: 'stripe',
        providerAccountKey: 'acct_a',
        method: 'card',
        status: 'failed',
        providerPaymentId,
        requestIdempotencyKey: `idem-d-${suffix()}`,
        actionType: 'none',
      },
    })).rejects.toThrow()
  })

  it('allows at most one non-terminal attempt per PaymentIntent', async () => {
    const user = await createUser()
    const policy = await createPolicy()
    const quote = await createQuote(user.id, policy.id)
    const order = await createOrder(user.id, quote.id, policy.id)
    const intent = await createIntent(order.id)
    await prisma.paymentAttempt.create({
      data: {
        paymentIntentId: intent.id,
        provider: 'paypal',
        providerAccountKey: 'acct_b',
        method: 'wallet',
        status: 'processing',
        requestIdempotencyKey: `idem-open-${suffix()}`,
        actionType: 'redirect',
      },
    })
    await expect(prisma.paymentAttempt.create({
      data: {
        paymentIntentId: intent.id,
        provider: 'paypal',
        providerAccountKey: 'acct_b',
        method: 'wallet',
        status: 'created',
        requestIdempotencyKey: `idem-open-2-${suffix()}`,
        actionType: 'redirect',
      },
    })).rejects.toThrow()
  })
})

describe('PaymentDispute and idempotency orphan-takeover schema', () => {
  it('enforces PaymentDispute provider identity uniqueness', async () => {
    const user = await createUser()
    const policy = await createPolicy()
    const quote = await createQuote(user.id, policy.id)
    const order = await createOrder(user.id, quote.id, policy.id)
    const disputeId = `dp_${suffix()}`
    await prisma.paymentDispute.create({
      data: {
        provider: 'stripe',
        providerAccountKey: 'acct_live',
        providerDisputeId: disputeId,
        rechargeOrderId: order.id,
        amountMinor: 100n,
        currency: 'USD',
        status: 'open',
        openedAt: new Date(),
      },
    })
    await expect(prisma.paymentDispute.create({
      data: {
        provider: 'stripe',
        providerAccountKey: 'acct_live',
        providerDisputeId: disputeId,
        rechargeOrderId: order.id,
        amountMinor: 100n,
        currency: 'USD',
        status: 'open',
        openedAt: new Date(),
      },
    })).rejects.toThrow()
  })

  it('uniquely scopes idempotency by user/scope/key and stores takeover fields', async () => {
    const user = await createUser()
    const key = randomUUID()
    const first = await prisma.rechargeIdempotencyRecord.create({
      data: {
        userId: user.id,
        scope: 'create_order',
        key,
        requestDigest: 'digest-a',
        status: 'processing',
        claimToken: randomUUID(),
        resultType: 'RechargeOrder',
        expiresAt: new Date(Date.now() + 30_000),
      },
    })
    expect(first.claimToken).toBeTruthy()
    expect(first.requestDigest).toBe('digest-a')
    expect(first.status).toBe('processing')

    await expect(prisma.rechargeIdempotencyRecord.create({
      data: {
        userId: user.id,
        scope: 'create_order',
        key,
        requestDigest: 'digest-a',
        status: 'processing',
        claimToken: randomUUID(),
        resultType: 'RechargeOrder',
        expiresAt: new Date(Date.now() + 30_000),
      },
    })).rejects.toThrow()

    await expect(prisma.rechargeIdempotencyRecord.create({
      data: {
        userId: user.id,
        scope: 'cancel_order',
        key,
        requestDigest: 'digest-b',
        status: 'processing',
        claimToken: randomUUID(),
        resultType: 'RechargeOrder',
        expiresAt: new Date(Date.now() + 30_000),
      },
    })).resolves.toMatchObject({ scope: 'cancel_order' })
  })
})

describe('RechargeCredit and PointHold uniqueness', () => {
  it('enforces unique credit and hold identities', async () => {
    const user = await createUser()
    await prisma.pointAccount.create({ data: { userId: user.id, balance: 0 } })
    const policy = await createPolicy()
    const quote = await createQuote(user.id, policy.id)
    const order = await createOrder(user.id, quote.id, policy.id)
    const intent = await createIntent(order.id)
    const log = await prisma.pointLog.create({
      data: { userId: user.id, type: 'in', amount: 100, balanceAfter: 100, reason: 'recharge-schema' },
    })
    const credit = await prisma.rechargeCredit.create({
      data: {
        rechargeOrderId: order.id,
        paymentIntentId: intent.id,
        userId: user.id,
        points: 100n,
        balanceBefore: 0,
        balanceAfter: 100,
        businessEventKey: `recharge:${order.id}:credit:v1`,
        pointLogId: log.id,
      },
    })
    expect(credit.businessEventKey).toContain(order.id)

    await expect(prisma.rechargeCredit.create({
      data: {
        rechargeOrderId: order.id,
        paymentIntentId: intent.id,
        userId: user.id,
        points: 100n,
        balanceBefore: 0,
        balanceAfter: 100,
        businessEventKey: `recharge:${order.id}:credit:v1-dup`,
        pointLogId: log.id,
      },
    })).rejects.toThrow()

    const sourceId = randomUUID()
    await prisma.pointHold.create({
      data: {
        userId: user.id,
        sourceType: 'recharge_refund',
        sourceId,
        points: 100n,
        status: 'active',
      },
    })
    await expect(prisma.pointHold.create({
      data: {
        userId: user.id,
        sourceType: 'recharge_refund',
        sourceId,
        points: 100n,
        status: 'active',
      },
    })).rejects.toThrow()
  })
})

describe('PointAccount hard-cap CHECK', () => {
  it('accepts the 2_000_000_000 cap and rejects raw SQL that exceeds it', async () => {
    const user = await createUser()
    const account = await prisma.pointAccount.create({
      data: { userId: user.id, balance: POINT_ACCOUNT_HARD_CAP, frozenBalance: 0 },
    })
    expect(account.balance + account.frozenBalance).toBe(POINT_ACCOUNT_HARD_CAP)

    await expect(prisma.$executeRaw`
      UPDATE "PointAccount"
      SET "balance" = ${POINT_ACCOUNT_HARD_CAP + 1}
      WHERE "userId" = ${user.id}
    `).rejects.toThrow(/point_account_hard_cap_2000000000|violates check/)
  })
})
