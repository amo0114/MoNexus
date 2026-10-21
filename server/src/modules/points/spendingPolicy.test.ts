import type { Prisma } from '@prisma/client'
import { describe, expect, it, vi } from 'vitest'
import { assertSpendingNotRestricted, hasActiveSpendingRestriction } from './spendingPolicy.js'
import { randomUUID } from 'node:crypto'
import { prisma } from '../../lib/prisma.js'
import { api, authHeader, createTestProduct, createTestUser, loginAs } from '../../__tests__/helpers.js'

describe('point spending restrictions', () => {
  it('blocks preview and checkout together, then permits spending after restriction release', async () => {
    const { user, password } = await createTestUser('spending-policy@test.local')
    const product = await createTestProduct('Restricted checkout', 100, 1, ['one-code'])
    const { accessToken } = await loginAs(user.email, password)
    const restriction = await prisma.accountRestriction.create({ data: {
      userId: user.id, sourceType: 'payment_dispute', sourceId: randomUUID(),
      blocksPointSpending: true, blocksRecharge: false, status: 'active',
    } })
    const preview = await api.get('/api/checkout/preview').query({ productId: product.id }).set(authHeader(accessToken)).expect(200)
    expect(preview.body.unpurchasableReason).toBe('当前账户暂不可消费积分')
    const blocked = await api.post('/api/orders').set(authHeader(accessToken)).set('Idempotency-Key', randomUUID()).send({ productId: product.id }).expect(403)
    expect(blocked.body.error.code).toBe('ACCOUNT_SPENDING_RESTRICTED')
    expect(await prisma.order.count()).toBe(0)
    expect((await prisma.pointAccount.findUniqueOrThrow({ where: { userId: user.id } })).balance).toBe(5000)
    await prisma.accountRestriction.update({ where: { id: restriction.id }, data: { status: 'released' } })
    expect(await hasActiveSpendingRestriction(user.id)).toBe(false)
    await api.post('/api/orders').set(authHeader(accessToken)).set('Idempotency-Key', randomUUID()).send({ productId: product.id }).expect(201)
  })

  it.each([null, { id: 'restriction' }])('uses the same restriction query for preview and debit: %j', async result => {
    const findFirst = vi.fn().mockResolvedValue(result)
    const tx = { accountRestriction: { findFirst } } as unknown as Pick<Prisma.TransactionClient, 'accountRestriction'>
    expect(await hasActiveSpendingRestriction(7, tx)).toBe(result != null)
    if (result) await expect(assertSpendingNotRestricted(7, tx)).rejects.toMatchObject({ code: 'ACCOUNT_SPENDING_RESTRICTED' })
    else await expect(assertSpendingNotRestricted(7, tx)).resolves.toBeUndefined()
    expect(findFirst).toHaveBeenCalledTimes(2)
    for (const [query] of findFirst.mock.calls) expect(query).toEqual({
      where: { userId: 7, status: 'active', blocksPointSpending: true }, select: { id: true },
    })
  })
})
