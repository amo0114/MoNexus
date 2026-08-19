import { randomUUID } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { rechargeLimitExceeded } from '../../lib/httpError.js'
import type { LimitPeriod } from './periods.js'

type Db = Prisma.TransactionClient

type BucketRow = {
  id: string
  reservedMinor: bigint
  consumedMinor: bigint
}

async function lockOrCreateBucket(
  tx: Db,
  input: {
    userId: number
    currency: string
    period: LimitPeriod
  },
): Promise<BucketRow> {
  const now = new Date()
  await tx.$executeRaw`
    INSERT INTO "RechargeLimitBucket" (
      "id", "userId", "currency", "periodType", "periodStart", "periodEnd",
      "reservedMinor", "consumedMinor", "createdAt", "updatedAt"
    ) VALUES (
      ${randomUUID()}::uuid, ${input.userId}, ${input.currency}, ${input.period.periodType},
      ${input.period.periodStart}, ${input.period.periodEnd}, 0, 0, ${now}, ${now}
    )
    ON CONFLICT ("userId", "currency", "periodType", "periodStart") DO NOTHING`

  const rows = await tx.$queryRaw<BucketRow[]>`
    SELECT "id", "reservedMinor", "consumedMinor"
    FROM "RechargeLimitBucket"
    WHERE "userId" = ${input.userId}
      AND "currency" = ${input.currency}
      AND "periodType" = ${input.period.periodType}
      AND "periodStart" = ${input.period.periodStart}
    FOR UPDATE`
  const row = rows[0]
  if (!row) throw new Error('failed to lock recharge limit bucket')
  return row
}

export async function reserveLimitBuckets(
  tx: Db,
  input: {
    userId: number
    currency: string
    amountMinor: bigint
    orderId: string
    expiresAt: Date
    dailyLimitMinor: bigint
    monthlyLimitMinor: bigint
    day: LimitPeriod
    month: LimitPeriod
  },
) {
  // Fixed lock order: day then month.
  const dayBucket = await lockOrCreateBucket(tx, { userId: input.userId, currency: input.currency, period: input.day })
  const monthBucket = await lockOrCreateBucket(tx, { userId: input.userId, currency: input.currency, period: input.month })

  if (dayBucket.reservedMinor + dayBucket.consumedMinor + input.amountMinor > input.dailyLimitMinor) {
    throw rechargeLimitExceeded()
  }
  if (monthBucket.reservedMinor + monthBucket.consumedMinor + input.amountMinor > input.monthlyLimitMinor) {
    throw rechargeLimitExceeded()
  }

  await tx.rechargeLimitBucket.update({
    where: { id: dayBucket.id },
    data: { reservedMinor: { increment: input.amountMinor } },
  })
  await tx.rechargeLimitBucket.update({
    where: { id: monthBucket.id },
    data: { reservedMinor: { increment: input.amountMinor } },
  })
  await tx.rechargeLimitReservation.createMany({
    data: [
      {
        rechargeOrderId: input.orderId,
        bucketId: dayBucket.id,
        periodType: 'day',
        amountMinor: input.amountMinor,
        status: 'reserved',
        expiresAt: input.expiresAt,
      },
      {
        rechargeOrderId: input.orderId,
        bucketId: monthBucket.id,
        periodType: 'month',
        amountMinor: input.amountMinor,
        status: 'reserved',
        expiresAt: input.expiresAt,
      },
    ],
  })
}

export async function releaseLimitReservations(tx: Db, orderId: string) {
  const reservations = await tx.rechargeLimitReservation.findMany({
    where: { rechargeOrderId: orderId, status: 'reserved' },
  })
  for (const reservation of reservations) {
    const released = await tx.rechargeLimitReservation.updateMany({
      where: { id: reservation.id, status: 'reserved' },
      data: { status: 'released' },
    })
    if (released.count !== 1) continue
    await tx.rechargeLimitBucket.update({
      where: { id: reservation.bucketId },
      data: { reservedMinor: { decrement: reservation.amountMinor } },
    })
  }
}

export async function remainingLimits(
  userId: number,
  currency: string,
  dailyLimitMinor: bigint,
  monthlyLimitMinor: bigint,
  day: LimitPeriod,
  month: LimitPeriod,
  db: Prisma.TransactionClient | typeof import('../../lib/prisma.js').prisma,
) {
  const [dayBucket, monthBucket] = await Promise.all([
    db.rechargeLimitBucket.findUnique({
      where: {
        userId_currency_periodType_periodStart: {
          userId,
          currency,
          periodType: 'day',
          periodStart: day.periodStart,
        },
      },
    }),
    db.rechargeLimitBucket.findUnique({
      where: {
        userId_currency_periodType_periodStart: {
          userId,
          currency,
          periodType: 'month',
          periodStart: month.periodStart,
        },
      },
    }),
  ])
  const dayUsed = (dayBucket?.reservedMinor ?? 0n) + (dayBucket?.consumedMinor ?? 0n)
  const monthUsed = (monthBucket?.reservedMinor ?? 0n) + (monthBucket?.consumedMinor ?? 0n)
  const dailyRemaining = dailyLimitMinor > dayUsed ? dailyLimitMinor - dayUsed : 0n
  const monthlyRemaining = monthlyLimitMinor > monthUsed ? monthlyLimitMinor - monthUsed : 0n
  return { dailyRemainingMinor: dailyRemaining, monthlyRemainingMinor: monthlyRemaining }
}
