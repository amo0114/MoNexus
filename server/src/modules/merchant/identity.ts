import { prisma } from '../../lib/prisma.js'
import { notFound } from '../../lib/httpError.js'

/** Public ownership lookup for callers outside merchant self-service flows. */
export async function getMerchantIdentity(userId: number) {
  const merchant = await prisma.merchant.findUnique({ where: { userId }, select: { id: true } })
  if (!merchant) throw notFound('商家账户不存在')
  return merchant
}
