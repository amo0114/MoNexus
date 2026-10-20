import type { Prisma } from '@prisma/client'
import { notFound } from '../../lib/httpError.js'

export async function lockProductRow(tx: Prisma.TransactionClient, productId: number) {
  const rows = await tx.$queryRaw<Array<{ id: number }>>`
    SELECT id FROM "Product" WHERE id = ${productId} FOR UPDATE
  `
  if (rows.length === 0) throw notFound('商品不存在')
  return tx.product.findUniqueOrThrow({ where: { id: productId } })
}
