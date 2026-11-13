import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { forbidden, notFound } from '../../lib/httpError.js'
import { logInventoryChange } from '../../lib/inventoryLog.js'
import { invalidateProductPublicCache } from '../../lib/productCatalog/publicCache.js'
import { assertPermission } from '../adminAuthorization/service.js'
import { assertMerchantOperation } from '../merchantGovernance/capability.js'
import { isAccountBanned } from '../accountGovernance/status.js'
import {
  commandInTx,
  cursorPage,
  decodeCursor,
  writeGovernanceAudit,
} from '../governance/common.js'

export async function assertProductTraceActor(
  actor: number,
  productId: number,
  admin: boolean,
  write = false,
  db: Prisma.TransactionClient = prisma,
) {
  if (admin) await assertPermission(actor, 'inventory.manage', db)
  const product = await db.product.findUnique({
    where: { id: productId },
    select: { merchantId: true, merchant: { select: { userId: true, status: true } } },
  })
  if (!product || (!admin && product.merchant?.userId !== actor)) throw notFound('商品不存在')
  if (await isAccountBanned(actor, db)) throw forbidden('账号被封禁')
  if (!admin && write) await assertMerchantOperation(db, product.merchantId!)
  return product
}
async function batchDto(
  db: Prisma.TransactionClient,
  batch: { id: string; [key: string]: unknown },
) {
  const counts = await db.inventoryItem.groupBy({
    by: ['status'],
    where: { batchId: batch.id },
    _count: { _all: true },
  })
  const count = (status: string) => counts.find((x) => x.status === status)?._count._all ?? 0
  return {
    ...batch,
    availableCount: count('available'),
    soldCount: count('sold'),
    voidCount: count('void'),
  }
}
export async function listBatches(
  actor: number,
  productId: number,
  admin: boolean,
  q: { cursor?: string; pageSize: number },
) {
  await assertProductTraceActor(actor, productId, admin)
  const scope = `inventory:${productId}`,
    c = decodeCursor(q.cursor, scope, 'uuid')
  const rows = await prisma.inventoryBatch.findMany({
    where: {
      productId,
      ...(c
        ? { OR: [{ createdAt: { lt: c.time } }, { createdAt: c.time, id: { lt: String(c.id) } }] }
        : {}),
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: q.pageSize + 1,
  })
  const page = cursorPage(rows, q.pageSize, scope)
  return { ...page, items: await Promise.all(page.items.map((b) => batchDto(prisma, b))) }
}
export async function batchDetail(
  actor: number,
  productId: number,
  batchId: string,
  admin: boolean,
  q: { cursor?: string; pageSize: number },
) {
  await assertProductTraceActor(actor, productId, admin)
  const batch = await prisma.inventoryBatch.findFirst({ where: { id: batchId, productId } })
  if (!batch) throw notFound('库存批次不存在')
  const scope = `batch-orders:${batchId}`,
    c = decodeCursor(q.cursor, scope, 'integer')
  const orders = await prisma.$queryRaw<
    Array<{ id: number; orderNo: string | null; createdAt: Date }>
  >`SELECT o.id,o."orderNo",o."createdAt" FROM "Order" o WHERE EXISTS(SELECT 1 FROM "InventoryItem" i WHERE i."batchId"=${batchId}::uuid AND i."orderId"=o.id) ${c ? Prisma.sql`AND (o."createdAt",o.id)<(${c.time},${Number(c.id)})` : Prisma.empty} ORDER BY o."createdAt" DESC,o.id DESC LIMIT ${q.pageSize + 1}`
  const page = cursorPage(orders, q.pageSize, scope)
  return {
    batch: await batchDto(prisma, batch),
    orders: page.items.map(({ createdAt, ...o }) => o),
    pageInfo: page.pageInfo,
  }
}
export async function voidBatch(
  actor: number,
  productId: number,
  batchId: string,
  admin: boolean,
  key: string,
  input: { reasonCode: string; note: string },
) {
  const result = await prisma.$transaction(async (tx) => {
    await assertProductTraceActor(actor, productId, admin, true, tx)
    return commandInTx(
      tx,
      actor,
      'inventory.batch.void',
      key,
      { productId, batchId, ...input },
      async () => {
        const batch = await tx.inventoryBatch.findFirst({ where: { id: batchId, productId } })
        if (!batch) throw notFound('库存批次不存在')
        const changed = await tx.inventoryItem.updateMany({
          where: { batchId, status: 'available' },
          data: { status: 'void' },
        })
        if (changed.count)
          await logInventoryChange(tx, {
            productId,
            offerId: batch.offerId,
            merchantId: batch.merchantId,
            actorUserId: actor,
            action: 'void',
            delta: -changed.count,
            reason: `${input.reasonCode}: ${input.note}`,
          })
        if (admin)
          await writeGovernanceAudit(tx, actor, 'inventory.batch.void', 'product', productId, {
            reasonCode: input.reasonCode,
            note: input.note,
            count: changed.count,
          })
        return { batch: await batchDto(tx, batch), voidedCount: changed.count, replayed: false }
      },
    )
  })
  await invalidateProductPublicCache(productId, { detail: true, list: 'coalesced' })
  return result
}
export async function listOfferRevisions(
  actor: number,
  productId: number,
  offerId: number,
  admin: boolean,
  q: { cursor?: string; pageSize: number },
) {
  if (admin) await assertPermission(actor, 'catalog.read')
  else await assertProductTraceActor(actor, productId, false)
  if (!(await prisma.offer.findFirst({ where: { id: offerId, productId }, select: { id: true } })))
    throw notFound('规格不存在')
  const scope = `offer:${offerId}`,
    c = decodeCursor(q.cursor, scope, 'uuid')
  const rows = await prisma.offerCommercialRevision.findMany({
    where: {
      offerId,
      ...(c
        ? { OR: [{ createdAt: { lt: c.time } }, { createdAt: c.time, id: { lt: String(c.id) } }] }
        : {}),
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: q.pageSize + 1,
  })
  return cursorPage(rows, q.pageSize, scope)
}
