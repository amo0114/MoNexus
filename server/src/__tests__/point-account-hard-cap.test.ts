import { describe, expect, it } from 'vitest'
import { HttpError } from '../lib/httpError.js'
import { prisma } from '../lib/prisma.js'
import { getSystemConfigValue } from '../lib/systemConfig.js'
import { adjustUserPoints } from '../modules/admin/service.js'
import { releaseMatureGrowthRewards } from '../modules/auth/growthRewards.js'
import {
  creditAvailablePoints,
  debitAvailablePoints,
  holdAvailablePoints,
  consumeHeldPoints,
  releaseHeldPoints,
  POINT_ACCOUNT_HARD_CAP,
} from '../modules/points/checkedMutation.js'
import { checkin } from '../modules/points/service.js'
import {
  creditPointsForPromotionRefund,
  debitPointsForPromotionCharge,
} from '../modules/merchandising/promotions/points.js'
import {
  refundPaidOrder,
  releaseHeldOrder,
} from '../modules/orders/accounting.js'
import { closeOrder, createOrder } from '../modules/orders/service.js'
import { createProductWithOffer, createTestUser } from './helpers.js'

const CAP = POINT_ACCOUNT_HARD_CAP
let serial = 0

function email(prefix: string) {
  serial += 1
  return `${prefix}-${serial}@hard-cap.test`
}

async function userWithBalances(balance: number, frozenBalance = 0) {
  const { user } = await createTestUser(email('pts'), 'pass123', 'user', 0)
  await prisma.pointAccount.update({
    where: { userId: user.id },
    data: { balance, frozenBalance },
  })
  return user
}

async function snapshot(userId: number) {
  const account = await prisma.pointAccount.findUniqueOrThrow({ where: { userId } })
  const logs = await prisma.pointLog.count({ where: { userId } })
  return { balance: account.balance, frozenBalance: account.frozenBalance, logs }
}

function expectCode(error: unknown, code: string) {
  expect(error).toBeInstanceOf(HttpError)
  expect((error as HttpError).code).toBe(code)
}

async function creditWithLog(userId: number, amount: number, reason: string) {
  return prisma.$transaction(async tx => {
    const { balance } = await creditAvailablePoints(tx, userId, amount)
    await tx.pointLog.create({
      data: { userId, type: 'in', amount, balanceAfter: balance, reason },
    })
    return balance
  })
}

async function debitWithLog(userId: number, amount: number, reason: string) {
  return prisma.$transaction(async tx => {
    const { balance } = await debitAvailablePoints(tx, userId, amount)
    await tx.pointLog.create({
      data: { userId, type: 'out', amount, balanceAfter: balance, reason },
    })
    return balance
  })
}

async function holdWithLog(userId: number, amount: number, reason: string) {
  return prisma.$transaction(async tx => {
    const { balance } = await holdAvailablePoints(tx, userId, amount)
    await tx.pointLog.create({
      data: { userId, type: 'hold', amount, balanceAfter: balance, reason },
    })
    return balance
  })
}

describe('PointAccount hard-cap mutations', () => {
  it('credits 1 at 1_999_999_999 and rejects the next credit with no PointLog', async () => {
    const user = await userWithBalances(1_999_999_999)
    const before = await snapshot(user.id)

    await expect(creditWithLog(user.id, 1, 'cap-boundary-ok')).resolves.toBe(CAP)
    expect(await snapshot(user.id)).toMatchObject({
      balance: CAP,
      frozenBalance: 0,
      logs: before.logs + 1,
    })

    await expect(creditWithLog(user.id, 1, 'cap-boundary-reject')).rejects.toSatisfy(
      (error: unknown) => error instanceof HttpError && error.code === 'POINT_BALANCE_HARD_CAP',
    )
    expect(await snapshot(user.id)).toMatchObject({
      balance: CAP,
      frozenBalance: 0,
      logs: before.logs + 1,
    })
  })

  it('rejects credit that would exceed the cap when frozenBalance already occupies the total', async () => {
    const user = await userWithBalances(0, CAP)
    const before = await snapshot(user.id)
    await expect(creditAvailablePoints(prisma, user.id, 1)).rejects.toSatisfy(
      (error: unknown) => error instanceof HttpError && error.code === 'POINT_BALANCE_HARD_CAP',
    )
    expect(await snapshot(user.id)).toEqual(before)
  })

  it('rejects debit and hold that would go negative and leaves balances unchanged', async () => {
    const user = await userWithBalances(10, 3)
    const before = await snapshot(user.id)

    await expect(debitAvailablePoints(prisma, user.id, 11)).rejects.toSatisfy(
      (error: unknown) => error instanceof HttpError && error.code === 'POINT_INSUFFICIENT',
    )
    await expect(holdAvailablePoints(prisma, user.id, 11)).rejects.toSatisfy(
      (error: unknown) => error instanceof HttpError && error.code === 'POINT_INSUFFICIENT',
    )
    expect(await snapshot(user.id)).toEqual(before)
  })

  it('hold then settle/release keep total within the cap', async () => {
    const user = await userWithBalances(1_000)
    await expect(holdAvailablePoints(prisma, user.id, 400)).resolves.toMatchObject({
      balance: 600,
      frozenBalance: 400,
    })

    await expect(releaseHeldPoints(prisma, user.id, 150)).resolves.toMatchObject({
      balance: 750,
      frozenBalance: 250,
    })
    expect(await snapshot(user.id)).toMatchObject({ balance: 750, frozenBalance: 250 })

    await expect(consumeHeldPoints(prisma, user.id, 250)).resolves.toMatchObject({
      balance: 750,
      frozenBalance: 0,
    })
    const after = await snapshot(user.id)
    expect(after.balance + after.frozenBalance).toBe(750)
    expect(after.balance + after.frozenBalance).toBeLessThanOrEqual(CAP)
  })

  it('allows two concurrent credits from CAP-2 and never exceeds the cap', async () => {
    const user = await userWithBalances(CAP - 2)
    const results = await Promise.allSettled([
      creditWithLog(user.id, 1, 'concurrent-credit-a'),
      creditWithLog(user.id, 1, 'concurrent-credit-b'),
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(2)
    expect(await snapshot(user.id)).toMatchObject({ balance: CAP, frozenBalance: 0 })
  })

  it('lets at most one concurrent credit succeed from CAP-1', async () => {
    const user = await userWithBalances(CAP - 1)
    const results = await Promise.allSettled([
      creditWithLog(user.id, 1, 'race-credit-a'),
      creditWithLog(user.id, 1, 'race-credit-b'),
    ])
    const fulfilled = results.filter(result => result.status === 'fulfilled')
    const rejected = results.filter(result => result.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expectCode((rejected[0] as PromiseRejectedResult).reason, 'POINT_BALANCE_HARD_CAP')
    expect(await snapshot(user.id)).toMatchObject({ balance: CAP, frozenBalance: 0 })
    expect(await prisma.pointLog.count({
      where: { userId: user.id, reason: { in: ['race-credit-a', 'race-credit-b'] } },
    })).toBe(1)
  })

  it('lets at most one concurrent debit succeed from a small balance', async () => {
    const user = await userWithBalances(10)
    const results = await Promise.allSettled([
      debitWithLog(user.id, 8, 'race-debit-a'),
      debitWithLog(user.id, 8, 'race-debit-b'),
    ])
    const fulfilled = results.filter(result => result.status === 'fulfilled')
    const rejected = results.filter(result => result.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expectCode((rejected[0] as PromiseRejectedResult).reason, 'POINT_INSUFFICIENT')
    const after = await snapshot(user.id)
    expect(after.balance).toBe(2)
    expect(after.frozenBalance).toBe(0)
    expect(after.balance).toBeGreaterThanOrEqual(0)
  })

  it('lets at most one concurrent hold succeed and conserves frozen+available', async () => {
    const user = await userWithBalances(10)
    const results = await Promise.allSettled([
      holdWithLog(user.id, 8, 'race-hold-a'),
      holdWithLog(user.id, 8, 'race-hold-b'),
    ])
    const fulfilled = results.filter(result => result.status === 'fulfilled')
    const rejected = results.filter(result => result.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expectCode((rejected[0] as PromiseRejectedResult).reason, 'POINT_INSUFFICIENT')
    const after = await snapshot(user.id)
    expect(after.balance).toBe(2)
    expect(after.frozenBalance).toBe(8)
    expect(after.balance + after.frozenBalance).toBe(10)
    expect(after.balance).toBeGreaterThanOrEqual(0)
  })

  it('rejects non-positive and non-integer mutation amounts', async () => {
    const user = await userWithBalances(10)
    for (const amount of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER]) {
      await expect(creditAvailablePoints(prisma, user.id, amount)).rejects.toSatisfy(
        (error: unknown) => error instanceof HttpError && error.code === 'BAD_REQUEST',
      )
    }
    expect(await snapshot(user.id)).toMatchObject({ balance: 10, frozenBalance: 0 })
  })

  it('fails check-in closed at the cap and still succeeds on a normal balance', async () => {
    const reward = await getSystemConfigValue('checkinReward')
    const capped = await userWithBalances(CAP)
    const before = await snapshot(capped.id)
    await expect(checkin(capped.id)).rejects.toSatisfy(
      (error: unknown) => error instanceof HttpError && error.code === 'POINT_BALANCE_HARD_CAP',
    )
    expect(await snapshot(capped.id)).toEqual(before)
    expect(await prisma.checkinRecord.count({ where: { userId: capped.id } })).toBe(0)

    const normal = await userWithBalances(20)
    const result = await checkin(normal.id)
    expect(result.totalReward).toBe(reward)
    expect(result.balanceAfter).toBe(20 + reward)
    expect(await snapshot(normal.id)).toMatchObject({
      balance: 20 + reward,
      frozenBalance: 0,
    })
  })

  it('fails admin add at the cap and keeps deduct from going negative', async () => {
    const { user: admin } = await createTestUser(email('admin'), 'pass123', 'admin', 0)
    const target = await userWithBalances(CAP)
    const before = await snapshot(target.id)
    await expect(adjustUserPoints(admin.id, target.id, 'add', 1, 'hard-cap add')).rejects.toSatisfy(
      (error: unknown) => error instanceof HttpError && error.code === 'POINT_BALANCE_HARD_CAP',
    )
    expect(await snapshot(target.id)).toEqual(before)

    const poor = await userWithBalances(5)
    await expect(adjustUserPoints(admin.id, poor.id, 'deduct', 6, 'over-deduct')).rejects.toMatchObject({
      code: 'POINT_INSUFFICIENT',
      message: expect.stringContaining('余额'),
    })
    expect(await snapshot(poor.id)).toMatchObject({ balance: 5, frozenBalance: 0 })

    await expect(adjustUserPoints(admin.id, poor.id, 'add', 3, 'ok add')).resolves.toEqual({ newBalance: 8 })
    await expect(adjustUserPoints(admin.id, poor.id, 'deduct', 2, 'ok deduct')).resolves.toEqual({ newBalance: 6 })
  })

  it('fails promotion refund at the cap and still charges a normal debit', async () => {
    const merchant = await userWithBalances(CAP)
    const before = await snapshot(merchant.id)
    await expect(prisma.$transaction(tx => creditPointsForPromotionRefund(tx, merchant.id, 1)))
      .rejects.toSatisfy(
        (error: unknown) => error instanceof HttpError && error.code === 'POINT_BALANCE_HARD_CAP',
      )
    expect(await snapshot(merchant.id)).toEqual(before)

    const payer = await userWithBalances(500)
    const charged = await prisma.$transaction(tx => debitPointsForPromotionCharge(tx, payer.id, 120))
    expect(charged).toMatchObject({ ok: true, balanceAfter: 380 })
    const insufficient = await prisma.$transaction(tx => debitPointsForPromotionCharge(tx, payer.id, 10_000))
    expect(insufficient).toMatchObject({ ok: false, balance: 380 })
    expect(await snapshot(payer.id)).toMatchObject({ balance: 380, frozenBalance: 0 })
  })

  it('fails growth-reward grant at the cap without writing PointLog', async () => {
    const user = await userWithBalances(CAP)
    await prisma.user.update({
      where: { id: user.id },
      data: { emailVerified: new Date() },
    })
    const reward = await prisma.growthReward.create({
      data: {
        recipientUserId: user.id,
        kind: 'registration',
        amount: 1,
        state: 'held',
        availableAt: new Date(Date.now() - 1_000),
        dedupeKey: `hard-cap:${user.id}`,
      },
    })
    const before = await snapshot(user.id)
    await expect(releaseMatureGrowthRewards()).rejects.toSatisfy(
      (error: unknown) => error instanceof HttpError && error.code === 'POINT_BALANCE_HARD_CAP',
    )
    await expect(prisma.growthReward.findUniqueOrThrow({ where: { id: reward.id } })).resolves.toMatchObject({
      state: 'held',
      grantedAt: null,
    })
    expect(await snapshot(user.id)).toEqual(before)
  })

  it('fails an order refund at the cap and still holds/debits/refunds on a normal balance', async () => {
    const product = await createProductWithOffer({
      data: {
        name: 'hard-cap instant',
        type: '邀请码',
        price: 100,
        status: 'active',
        deliveryMode: 'instant_fixed',
        stockMode: 'unlimited',
        fixedContent: 'HARD-CAP-FIXED',
      },
    })
    const buyer = await userWithBalances(500)
    const { orderId } = await createOrder(buyer.id, product.id)
    expect(await snapshot(buyer.id)).toMatchObject({ balance: 400, frozenBalance: 0 })

    await prisma.pointAccount.update({
      where: { userId: buyer.id },
      data: { balance: CAP },
    })
    const beforeRefund = await snapshot(buyer.id)
    await expect(prisma.$transaction(tx => refundPaidOrder(
      tx,
      { id: orderId, userId: buyer.id, price: 100 },
      'hard-cap refund',
    ))).rejects.toSatisfy(
      (error: unknown) => error instanceof HttpError && error.code === 'POINT_BALANCE_HARD_CAP',
    )
    expect(await snapshot(buyer.id)).toEqual(beforeRefund)
    expect(await prisma.pointLog.count({
      where: { userId: buyer.id, orderId, type: 'refund' },
    })).toBe(0)

    const happy = await userWithBalances(500)
    const { orderId: happyOrderId } = await createOrder(happy.id, product.id)
    await prisma.$transaction(tx => refundPaidOrder(
      tx,
      { id: happyOrderId, userId: happy.id, price: 100 },
      'happy refund',
    ))
    expect(await snapshot(happy.id)).toMatchObject({ balance: 500, frozenBalance: 0 })
  })

  it('holds, settles and releases through order accounting without regressing', async () => {
    const product = await createProductWithOffer({
      data: {
        name: 'hard-cap manual',
        type: '网络节点',
        price: 300,
        status: 'active',
        deliveryMode: 'manual_service',
        stockMode: 'unlimited',
      },
    })
    const buyer = await userWithBalances(1_000)
    const { orderId } = await createOrder(buyer.id, product.id)
    expect(await snapshot(buyer.id)).toMatchObject({ balance: 700, frozenBalance: 300 })

    await prisma.order.update({ where: { id: orderId }, data: { status: 'delivered' } })
    await closeOrder(orderId, buyer.id)
    expect(await snapshot(buyer.id)).toMatchObject({ balance: 700, frozenBalance: 0 })

    const releaser = await userWithBalances(1_000)
    const held = await createOrder(releaser.id, product.id)
    expect(await snapshot(releaser.id)).toMatchObject({ balance: 700, frozenBalance: 300 })
    await prisma.$transaction(tx => releaseHeldOrder(
      tx,
      { id: held.orderId, userId: releaser.id, holdingPoints: 300, fundsHeld: true },
      'release regression',
    ))
    expect(await snapshot(releaser.id)).toMatchObject({ balance: 1_000, frozenBalance: 0 })
  })
})
