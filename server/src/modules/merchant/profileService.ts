import { assertMerchantOperation } from '../merchantGovernance/capability.js'
import { submitMerchantApplication } from '../merchantGovernance/lifecycle.js'
import { prisma } from '../../lib/prisma.js'
import { notFound, conflict } from '../../lib/httpError.js'

// ---- Application ----

export async function applyForMerchant(
  userId: number,
  data: { name: string; description?: string; contactEmail?: string; contactPhone?: string }
) {
  await submitMerchantApplication(userId, data, `legacy-application:${userId}`)
  return prisma.merchant.findUniqueOrThrow({ where: { userId } })
}

// ---- Profile ----

export async function getMyMerchant(userId: number) {
  const merchant = await prisma.merchant.findUnique({
    where: { userId },
    include: { user: { select: { email: true } } },
  })
  if (!merchant) throw notFound('商家账户不存在')
  return merchant
}

export async function updateMyMerchant(
  userId: number,
  data: { name?: string; description?: string; contactEmail?: string; contactPhone?: string }
) {
  const merchant = await prisma.merchant.findUnique({ where: { userId } })
  if (!merchant) throw notFound('商家账户不存在')

  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "Merchant" WHERE id=${merchant.id} FOR NO KEY UPDATE`
    await assertMerchantOperation(tx, merchant.id, true, false)
    return tx.merchant.update({ where: { userId }, data })
  })
}
