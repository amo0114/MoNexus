import { describe, it, expect } from 'vitest'
import { prisma } from '../lib/prisma.js'
import {
  api,
  authHeader,
  configureDefaultOffer,
  createTestMerchant,
  createTestProduct,
  createTestUser,
  loginAs,
  loginAsMerchant,
} from './helpers.js'

/**
 * 2026-09 生产安全审计回应（高危项「订单关闭未回滚资源」）。
 *
 * 审计报告把 POST /orders/:id/close 当作「取消订单」，并据此推断关闭会退还
 * 冻结积分、结算应作废、库存应回补。产品语义恰恰相反：close 是买家验收
 * （前端文案「验收通过 / 确认后订单关闭并结算给商家」，PRD §4.3.1），冻结
 * 积分正式扣除、结算由 holding 转为 pending、已交付的服务名额不复活。
 *
 * 本用例按报告的复现步骤（限量人工服务 → 冻结 100 → 商家交付 → 买家关闭 →
 * 管理员批量结算）逐项核对账目守恒：买家 −100、商家 +90、平台佣金 10，
 * 没有任何退款/释放流水，库存只有一条出库记录。任何让 close 变成退款的
 * 改动都会让这条用例失败。
 */
describe('order close ledger conservation (audit 2026-09 high finding)', () => {
  it('close consumes the hold, settlement pays the merchant, nothing is refunded or restocked', async () => {
    await createTestUser('close-audit-admin@test.local', 'admin123', 'admin')
    const { merchant, user: merchantUser } = await createTestMerchant('close-audit-merchant@test.local', 'pass123', {
      role: 'merchant',
      status: 'active',
      name: '验收结算商家',
      commissionRate: 0.1,
      balance: 5000,
    })
    const { user: buyer } = await createTestUser('close-audit-buyer@test.local', 'pass123', 'user', 1000)
    const product = await createTestProduct('限量人工服务', 100, 3, [], merchant.id)
    await configureDefaultOffer(product.id, { deliveryMode: 'manual_service', stockMode: 'limited', stock: 3 })
    const offerId = (await prisma.offer.findFirstOrThrow({ where: { productId: product.id } })).id

    const buyerLogin = await loginAs('close-audit-buyer@test.local', 'pass123')
    const created = await api
      .post('/api/orders')
      .set(authHeader(buyerLogin.accessToken))
      .send({ productId: product.id })
      .expect(201)
    const orderId = created.body.orderId as number

    // 下单：可用 900 / 冻结 100，服务名额 3 → 2，一条 sale 流水，结算 holding。
    let account = await prisma.pointAccount.findUniqueOrThrow({ where: { userId: buyer.id } })
    expect(account).toMatchObject({ balance: 900, frozenBalance: 100 })
    expect((await prisma.offer.findUniqueOrThrow({ where: { id: offerId } })).stock).toBe(2)
    expect((await prisma.product.findUniqueOrThrow({ where: { id: product.id } })).stock).toBe(2)
    expect(await prisma.inventoryLog.findMany({ where: { orderId } })).toHaveLength(1)
    expect((await prisma.settlement.findUniqueOrThrow({ where: { orderId } })).status).toBe('holding')

    const merchantLogin = await loginAsMerchant('close-audit-merchant@test.local', 'pass123')
    await api
      .post(`/api/merchant/orders/${orderId}/fulfillment/start`)
      .set(authHeader(merchantLogin.accessToken))
      .send({})
      .expect(200)
    await api
      .post(`/api/merchant/orders/${orderId}/fulfillment/deliver`)
      .set(authHeader(merchantLogin.accessToken))
      .send({ deliveryContent: '服务已完成' })
      .expect(200)

    // 买家关闭（验收）：可用积分保持 900（没有退回 100），冻结归零。
    const closed = await api
      .post(`/api/orders/${orderId}/close`)
      .set(authHeader(buyerLogin.accessToken))
      .expect(200)
    expect(closed.body.status).toBe('closed')

    account = await prisma.pointAccount.findUniqueOrThrow({ where: { userId: buyer.id } })
    expect(account).toMatchObject({ balance: 900, frozenBalance: 0 })

    const buyerLogs = await prisma.pointLog.findMany({ where: { orderId, userId: buyer.id }, orderBy: { id: 'asc' } })
    expect(buyerLogs.map(log => log.type)).toEqual(['hold', 'out'])
    expect(buyerLogs.every(log => log.amount === 100)).toBe(true)
    expect(buyerLogs.some(log => log.type === 'refund' || log.type === 'release')).toBe(false)

    // 结算转为 pending（可结算），不是 voided；已交付的名额不回补，销量保留。
    const settlement = await prisma.settlement.findUniqueOrThrow({ where: { orderId } })
    expect(settlement.status).toBe('pending')
    expect(settlement.settlementAmount).toBe(90)
    expect(settlement.commissionAmount).toBe(10)
    expect((await prisma.offer.findUniqueOrThrow({ where: { id: offerId } })).stock).toBe(2)
    expect((await prisma.product.findUniqueOrThrow({ where: { id: product.id } })).sales).toBe(1)
    const inventoryLogs = await prisma.inventoryLog.findMany({ where: { orderId } })
    expect(inventoryLogs.map(log => log.action)).toEqual(['sale'])

    // 关闭是终态：不能再争议/再关闭去争取退款。
    await api.post(`/api/orders/${orderId}/dispute`).set(authHeader(buyerLogin.accessToken)).expect(400)
    await api.post(`/api/orders/${orderId}/close`).set(authHeader(buyerLogin.accessToken)).expect(400)

    // 管理员批量结算：商家 +90，且只能结算一次。
    const admin = await loginAs('close-audit-admin@test.local', 'admin123')
    const settled = await api
      .post('/api/admin/settlements/batch-settle')
      .set(authHeader(admin.accessToken))
      .send({ settlementIds: [settlement.id] })
      .expect(200)
    expect(settled.body.creditedTotal).toBe(90)
    await api
      .post('/api/admin/settlements/batch-settle')
      .set(authHeader(admin.accessToken))
      .send({ settlementIds: [settlement.id] })
      .expect(400)

    const merchantAccount = await prisma.pointAccount.findUniqueOrThrow({ where: { userId: merchantUser.id } })
    expect(merchantAccount.balance).toBe(5090)

    // 守恒：买家支出 = 商家入账 + 平台佣金。
    const buyerDelta = account.balance + account.frozenBalance - 1000
    const merchantDelta = merchantAccount.balance - 5000
    expect(buyerDelta).toBe(-100)
    expect(merchantDelta).toBe(90)
    expect(buyerDelta + merchantDelta + settlement.commissionAmount).toBe(0)
  })

  it('only merchant rejection of an undelivered order refunds the hold, voids settlement and restocks', async () => {
    const { merchant } = await createTestMerchant('reject-audit-merchant@test.local', 'pass123', {
      role: 'merchant',
      status: 'active',
      name: '拒单回补商家',
    })
    const { user: buyer } = await createTestUser('reject-audit-buyer@test.local', 'pass123', 'user', 1000)
    const product = await createTestProduct('限量人工服务B', 100, 1, [], merchant.id)
    await configureDefaultOffer(product.id, { deliveryMode: 'manual_service', stockMode: 'limited', stock: 1 })
    const offerId = (await prisma.offer.findFirstOrThrow({ where: { productId: product.id } })).id

    const buyerLogin = await loginAs('reject-audit-buyer@test.local', 'pass123')
    const created = await api
      .post('/api/orders')
      .set(authHeader(buyerLogin.accessToken))
      .send({ productId: product.id })
      .expect(201)
    const orderId = created.body.orderId as number
    expect((await prisma.offer.findUniqueOrThrow({ where: { id: offerId } })).stock).toBe(0)

    const merchantLogin = await loginAsMerchant('reject-audit-merchant@test.local', 'pass123')
    await api
      .post(`/api/merchant/orders/${orderId}/fulfillment/reject`)
      .set(authHeader(merchantLogin.accessToken))
      .send({ publicNote: '暂时无法服务' })
      .expect(200)

    const account = await prisma.pointAccount.findUniqueOrThrow({ where: { userId: buyer.id } })
    expect(account).toMatchObject({ balance: 1000, frozenBalance: 0 })
    expect((await prisma.settlement.findUniqueOrThrow({ where: { orderId } })).status).toBe('voided')
    expect((await prisma.offer.findUniqueOrThrow({ where: { id: offerId } })).stock).toBe(1)
    const inventoryLogs = await prisma.inventoryLog.findMany({ where: { orderId }, orderBy: { id: 'asc' } })
    expect(inventoryLogs.map(log => log.action)).toEqual(['sale', 'refund_restock'])
  })
})
