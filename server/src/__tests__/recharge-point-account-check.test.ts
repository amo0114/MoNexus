import { describe, expect, it } from 'vitest'
import { HttpError } from '../lib/httpError.js'
import { prisma } from '../lib/prisma.js'
import {
  POINT_ACCOUNT_HARD_CAP,
  classifyPointAccountWriteError,
  creditAvailablePoints,
} from '../modules/points/checkedMutation.js'

const CAP = POINT_ACCOUNT_HARD_CAP
let serial = 0

async function userWithBalances(balance: number, frozenBalance = 0) {
  serial += 1
  const user = await prisma.user.create({
    data: { email: `recharge-cap-${serial}@t.local`, password: 'x' },
  })
  await prisma.pointAccount.create({
    data: { userId: user.id, balance, frozenBalance },
  })
  return user
}

describe('PR-A0 helper plus PointAccount CHECK boundary', () => {
  it('credits exactly to the cap and maps a +1 helper credit to a business error', async () => {
    const user = await userWithBalances(CAP - 1)
    await expect(creditAvailablePoints(prisma, user.id, 1)).resolves.toMatchObject({
      balance: CAP,
      frozenBalance: 0,
    })
    await expect(creditAvailablePoints(prisma, user.id, 1)).rejects.toSatisfy(
      (error: unknown) => error instanceof HttpError && error.code === 'POINT_BALANCE_HARD_CAP',
    )
    const account = await prisma.pointAccount.findUniqueOrThrow({ where: { userId: user.id } })
    expect(account.balance + account.frozenBalance).toBe(CAP)
  })

  it('maps the named CHECK to POINT_BALANCE_HARD_CAP and rejects raw SQL +1', async () => {
    const named = new Error(
      'new row for relation "PointAccount" violates check constraint "point_account_hard_cap_2000000000"',
    ) as Error & { code: string }
    named.code = 'P2004'
    expect(classifyPointAccountWriteError(named)?.code).toBe('POINT_BALANCE_HARD_CAP')

    const user = await userWithBalances(CAP)
    await expect(prisma.$executeRaw`
      UPDATE "PointAccount"
      SET "balance" = "balance" + 1
      WHERE "userId" = ${user.id}
    `).rejects.toThrow(/point_account_hard_cap_2000000000|violates check/)
  })
})
