import type { Prisma } from '@prisma/client'
import { describe, expect, it, vi } from 'vitest'
import { assertOwnedActiveDeliveryFile, type DeliveryFileActor } from './deliveryFileOwnership.js'

function database(status: string | null) {
  const findFirst = vi.fn().mockResolvedValue(status == null ? null : { status })
  const db = { deliveryFile: { findFirst } } as unknown as Pick<Prisma.TransactionClient, 'deliveryFile'>
  return { db, findFirst }
}

describe('delivery file ownership policy', () => {
  it.each([
    [{ kind: 'merchant', merchantId: 7 }, 7],
    [{ kind: 'admin' }, null],
  ] as const)('scopes lookup to the owner for %j', async (actor, merchantId) => {
    const { db, findFirst } = database('active')
    await assertOwnedActiveDeliveryFile(db, actor, 42)
    expect(findFirst).toHaveBeenCalledWith({ where: { id: 42, merchantId }, select: { status: true } })
  })

  it.each<DeliveryFileActor>([{ kind: 'merchant', merchantId: 7 }, { kind: 'admin' }])('returns 404 for missing or foreign files for %j', async actor => {
    const { db } = database(null)
    await expect(assertOwnedActiveDeliveryFile(db, actor, 42)).rejects.toMatchObject({ status: 404, message: '交付文件不存在' })
  })

  it.each(['revoked', 'deleted'])('rejects owned %s files with 400', async status => {
    const { db } = database(status)
    await expect(assertOwnedActiveDeliveryFile(db, { kind: 'admin' }, 42)).rejects.toMatchObject({ status: 400 })
  })
})
