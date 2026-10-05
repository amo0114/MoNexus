import { describe, expect, it } from 'vitest'
import { prisma } from '../lib/prisma.js'
import { backfillFakaOrderPayment, listFakaPaymentBackfillCandidates } from '../lib/fakaBridge/paymentBackfill.js'
import { createTestMerchant, createTestUser } from './helpers.js'
import { getActiveNetworkNodeCategoryId } from './catalogFixture.js'

async function createHistoricalHeldOrder() {
  const { user } = await createTestUser('historical-xboard@example.com', 'testpass123', 'user', 1000)
  const { merchant } = await createTestMerchant('historical-xboard-merchant@example.com', 'testpass123', { balance: 0 })
  const product = await prisma.product.create({
    data: {
      name: 'Historical Xboard test',
      type: '网络节点',
      categoryId: await getActiveNetworkNodeCategoryId(),
      price: 200,
      merchantId: merchant.id,
      deliveryMode: 'manual_service',
      stockMode: 'unlimited',
    },
  })
  const order = await prisma.order.create({
    data: {
      userId: user.id,
      productId: product.id,
      merchantId: merchant.id,
      price: 200,
      status: 'delivered',
      deliveryModeSnapshot: 'manual_service',
      holdingPoints: 200,
      fundsHeld: true,
    },
  })
  await prisma.pointAccount.update({ where: { userId: user.id }, data: { balance: 800, frozenBalance: 200 } })
  await prisma.pointLog.create({
    data: { orderId: order.id, userId: user.id, type: 'hold', amount: 200, balanceAfter: 800 },
  })
  const task = await prisma.fakaBridgeTask.create({
    data: {
      orderId: order.id,
      status: 'succeeded',
      completedAt: new Date(),
      requestOrderNo: `MN-${order.id}`,
      emailSnapshot: user.email,
      skuSnapshot: 'plan-1-monthly',
    },
  })
  await prisma.deliveryRecord.create({
    data: { orderId: order.id, userId: user.id, productId: product.id, status: 'delivered', deliveredAt: new Date() },
  })
  await prisma.settlement.create({
    data: { orderId: order.id, merchantId: merchant.id, orderAmount: 200, commissionRate: 0.1, commissionAmount: 20, settlementAmount: 180, status: 'holding' },
  })
  return { user, order, task, product }
}

describe('historical Xboard payment backfill', () => {
  it('previews without changing funds, delivery, tasks, settlement or audit events', async () => {
    const { user, order, task } = await createHistoricalHeldOrder()
    expect(await listFakaPaymentBackfillCandidates()).toEqual([order.id])
    expect(await backfillFakaOrderPayment(order.id)).toMatchObject({ status: 'eligible', amount: 200 })
    expect(await prisma.pointAccount.findUniqueOrThrow({ where: { userId: user.id } })).toMatchObject({ balance: 800, frozenBalance: 200 })
    expect(await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({ status: 'delivered', fundsHeld: true, holdingPoints: 200 })
    expect(await prisma.fakaBridgeTask.findUniqueOrThrow({ where: { id: task.id } })).toEqual(task)
    expect((await prisma.settlement.findUniqueOrThrow({ where: { orderId: order.id } })).status).toBe('holding')
    expect(await prisma.orderStatusEvent.count({ where: { orderId: order.id } })).toBe(0)
    expect(await prisma.pointLog.count({ where: { orderId: order.id } })).toBe(1)
  })

  it('captures exactly once with an audit record, retaining the delivery and merchant payout gate', async () => {
    const { user, order } = await createHistoricalHeldOrder()
    expect(await backfillFakaOrderPayment(order.id, { apply: true, operator: 'change-test-123' })).toMatchObject({ status: 'captured', amount: 200 })
    expect(await backfillFakaOrderPayment(order.id, { apply: true, operator: 'retry-test' })).toMatchObject({ status: 'skipped', reason: 'no_active_reservation' })
    expect(await prisma.pointAccount.findUniqueOrThrow({ where: { userId: user.id } })).toMatchObject({ balance: 800, frozenBalance: 0 })
    expect(await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({ status: 'delivered', holdingPoints: null, fundsHeld: false, confirmedAt: null })
    expect((await prisma.settlement.findUniqueOrThrow({ where: { orderId: order.id } })).status).toBe('holding')
    expect(await prisma.pointLog.count({ where: { orderId: order.id, type: 'out' } })).toBe(1)
    const events = await prisma.orderStatusEvent.findMany({ where: { orderId: order.id } })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ action: 'system.faka_bridge.payment_backfill', internalNote: 'Operator reference: change-test-123', fromStatus: 'delivered', toStatus: 'delivered' })
  })

  it('does not double charge when two explicit backfills compete for the same order', async () => {
    const { user, order } = await createHistoricalHeldOrder()
    const results = await Promise.allSettled([
      backfillFakaOrderPayment(order.id, { apply: true, operator: 'concurrent-first' }),
      backfillFakaOrderPayment(order.id, { apply: true, operator: 'concurrent-second' }),
    ])
    const captured = results.filter(result => result.status === 'fulfilled' && result.value.status === 'captured')
    expect(captured).toHaveLength(1)
    // A serializable conflict may reject the loser; re-running must safely skip.
    expect((await backfillFakaOrderPayment(order.id, { apply: true, operator: 'concurrent-retry' })).reason).toBe('no_active_reservation')
    expect((await prisma.pointAccount.findUniqueOrThrow({ where: { userId: user.id } })).frozenBalance).toBe(0)
    expect(await prisma.pointLog.count({ where: { orderId: order.id, type: 'out' } })).toBe(1)
    expect(await prisma.orderStatusEvent.count({ where: { orderId: order.id } })).toBe(1)
  })

  it('rolls back the capture if its audit event cannot be saved', async () => {
    const { user, order } = await createHistoricalHeldOrder()
    // Test database only: fail the final write to verify accounting and audit atomicity.
    await prisma.$executeRawUnsafe(`CREATE FUNCTION fail_payment_backfill_audit() RETURNS trigger AS $$
      BEGIN
        IF NEW.action = 'system.faka_bridge.payment_backfill' THEN
          RAISE EXCEPTION 'Injected audit failure';
        END IF;
        RETURN NEW;
      END;
    $$ LANGUAGE plpgsql`)
    try {
      await prisma.$executeRawUnsafe(`CREATE TRIGGER fail_payment_backfill_audit_trigger
        BEFORE INSERT ON "OrderStatusEvent" FOR EACH ROW EXECUTE FUNCTION fail_payment_backfill_audit()`)
      await expect(backfillFakaOrderPayment(order.id, { apply: true, operator: 'audit-failure-test' })).rejects.toThrow()
      expect(await prisma.pointAccount.findUniqueOrThrow({ where: { userId: user.id } })).toMatchObject({ balance: 800, frozenBalance: 200 })
      expect(await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({ holdingPoints: 200, fundsHeld: true })
      expect(await prisma.pointLog.count({ where: { orderId: order.id, type: 'out' } })).toBe(0)
      expect(await prisma.orderStatusEvent.count({ where: { orderId: order.id } })).toBe(0)
    } finally {
      await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS fail_payment_backfill_audit_trigger ON "OrderStatusEvent"')
      await prisma.$executeRawUnsafe('DROP FUNCTION fail_payment_backfill_audit()')
    }
  })

  it.each(['pending', 'disputed', 'refunded', 'closed'])('does not charge an order in %s state', async status => {
    const { user, order } = await createHistoricalHeldOrder()
    await prisma.order.update({ where: { id: order.id }, data: { status } })
    expect(await backfillFakaOrderPayment(order.id, { apply: true, operator: 'state-test' })).toMatchObject({ status: 'skipped', reason: 'order_not_delivered' })
    expect((await prisma.pointAccount.findUniqueOrThrow({ where: { userId: user.id } })).frozenBalance).toBe(200)
  })

  it.each(['pending_task', 'cancellation', 'revoke', 'no_delivery', 'existing_out', 'missing_hold', 'settled_merchant'] as const)(
    'refuses unsafe history: %s', async condition => {
      const { user, order, task } = await createHistoricalHeldOrder()
      if (condition === 'pending_task') await prisma.fakaBridgeTask.update({ where: { id: task.id }, data: { status: 'pending' } })
      if (condition === 'cancellation') await prisma.fakaBridgeTask.update({ where: { id: task.id }, data: { cancelRequested: true } })
      if (condition === 'revoke') await prisma.fakaBridgeTask.update({ where: { id: task.id }, data: { revokeStatus: 'pending' } })
      if (condition === 'no_delivery') await prisma.deliveryRecord.delete({ where: { orderId: order.id } })
      if (condition === 'existing_out') await prisma.pointLog.create({ data: { orderId: order.id, userId: user.id, type: 'out', amount: 200, balanceAfter: 800 } })
      if (condition === 'missing_hold') await prisma.pointLog.deleteMany({ where: { orderId: order.id } })
      if (condition === 'settled_merchant') await prisma.settlement.update({ where: { orderId: order.id }, data: { status: 'settled' } })
      expect((await backfillFakaOrderPayment(order.id, { apply: true, operator: 'unsafe-test' })).status).toBe('skipped')
      expect((await prisma.pointAccount.findUniqueOrThrow({ where: { userId: user.id } })).frozenBalance).toBe(200)
      expect(await prisma.orderStatusEvent.count({ where: { orderId: order.id } })).toBe(0)
    },
  )

  it('does not spend another order reservation when the shared frozen account is inconsistent', async () => {
    const { user, order, product } = await createHistoricalHeldOrder()
    await prisma.order.create({
      data: { userId: user.id, productId: product.id, price: 100, status: 'pending', holdingPoints: 100, fundsHeld: true },
    })
    expect(await backfillFakaOrderPayment(order.id, { apply: true, operator: 'account-test' })).toMatchObject({ status: 'skipped', reason: 'account_reservation_mismatch' })
    expect((await prisma.pointAccount.findUniqueOrThrow({ where: { userId: user.id } })).frozenBalance).toBe(200)
  })

  it('rejects an apply invocation without an audit operator', async () => {
    await expect(backfillFakaOrderPayment(1, { apply: true })).rejects.toThrow('operator reference')
  })

  it('never captures a normal manual-service order without Xboard evidence', async () => {
    const { order, task } = await createHistoricalHeldOrder()
    await prisma.fakaBridgeTask.delete({ where: { id: task.id } })
    expect(await backfillFakaOrderPayment(order.id, { apply: true, operator: 'manual-test' })).toMatchObject({ status: 'skipped', reason: 'not_xboard_order' })
  })
})
