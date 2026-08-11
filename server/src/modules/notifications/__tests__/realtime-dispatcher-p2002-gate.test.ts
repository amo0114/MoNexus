import { describe, expect, it } from 'vitest'
import { Prisma } from '@prisma/client'
import { prisma } from '../../../lib/prisma.js'

/**
 * Problem 4 risk gate — empirical result recorded as a regression test.
 *
 * The planned optimization (single `tx.notification.create` + catch P2002 instead
 * of `createMany(skipDuplicates)` + `findFirst`) was probed against the real test
 * DB before implementation. PostgreSQL aborts the entire transaction block on the
 * first failing statement, and Prisma interactive transactions do NOT wrap each
 * query in a savepoint, so a *caught* P2002 still poisons the transaction: the
 * next statement fails with `25P02 "current transaction is aborted"` and the whole
 * callback rolls back — including legitimate business writes.
 *
 * Verdict: ABANDONED per plan (the only item with a "may not do" exit). The current
 * `createMany + skipDuplicates + findFirst` implementation is kept. This test locks
 * in the abort behavior so the optimization is not re-attempted blindly.
 */
describe('P2002 inside a Prisma interactive transaction (problem 4 risk gate)', () => {
  it('a caught P2002 aborts the interactive transaction for subsequent writes', async () => {
    const user = await prisma.user.create({
      data: { email: `p2002-gate-${Date.now()}@test.local`, password: 'hashed', role: 'user' },
    })

    const base = {
      recipientUserId: user.id,
      recipientRole: 'user',
      eventType: 'order.delivered_buyer',
      category: 'order',
      title: 't',
      body: 'b',
      level: 'info',
      status: 'unread',
      deeplink: '/orders?focus=1',
      relatedOrderId: 1,
    }
    const dedupeKey = `p2002-gate-${user.id}`

    let caughtP2002 = false
    let subsequentWriteOk = false
    let committed = false
    let rejectedMessage = ''

    try {
      await prisma.$transaction(async (tx) => {
        await tx.notification.create({ data: { ...base, dedupeKey }, select: { id: true } })

        // Duplicate create against the same @@unique triplet -> P2002, caught here.
        try {
          await tx.notification.create({ data: { ...base, dedupeKey }, select: { id: true } })
        } catch (err) {
          caughtP2002 =
            err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'
        }

        // The crux: a subsequent business write inside the SAME transaction.
        const second = await tx.notification.create({
          data: { ...base, dedupeKey: `${dedupeKey}-b`, title: 't2' },
          select: { id: true },
        })
        subsequentWriteOk = second.id > 0
      })
      committed = true
    } catch (err) {
      rejectedMessage = (err as Error).message
    }

    // The unique conflict was raised as P2002 and caught...
    expect(caughtP2002).toBe(true)
    // ...but it poisoned the transaction: the follow-up write failed with 25P02.
    expect(subsequentWriteOk).toBe(false)
    expect(committed).toBe(false)
    expect(rejectedMessage).toContain('current transaction is aborted')

    // Nothing was persisted — the whole callback rolled back.
    expect(
      await prisma.notification.count({ where: { recipientUserId: user.id } }),
    ).toBe(0)
  })
})
