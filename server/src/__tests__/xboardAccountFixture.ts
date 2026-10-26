import { randomUUID } from 'node:crypto'
import { vi } from 'vitest'
import { prisma } from '../lib/prisma.js'
import { config } from '../config/index.js'
import * as bridge from '../lib/fakaBridge/accountV2.js'
import { getActiveNetworkNodeCategoryId } from './catalogFixture.js'
import { clearAccountQueryCachesForTests } from '../modules/xboardAccounts/bridgeQueries.js'

export const instanceId = 'xboard-test'
export function enableAccountTests() {
  const old = { xboardAccounts: { ...config.xboardAccounts }, fakaBridge: { ...config.fakaBridge }, chatBot: { ...config.chatBot } }
  Object.assign(config.xboardAccounts, { enabled: true, instanceId })
  Object.assign(config.fakaBridge, { enabled: true, url: 'https://xboard.test/plugin/faka-bridge/order-paid', secret: 'bridge-test' })
  Object.assign(config.chatBot, { enabled: true, secret: 'bot-test' })
  clearAccountQueryCachesForTests()
  vi.spyOn(bridge, 'callFakaV2Capabilities').mockResolvedValue({ ok: true, httpStatus: 200, body: {
    success: true, protocol_version: 2, request_id: randomUUID(), queried_at: new Date().toISOString(),
    plugin_version: '1.6.0', build_id: 'a'.repeat(64), core_adapter: 'xboard-eloquent-read-v1',
    capabilities: { resolve_by_order: true, subscription_by_user_id: true, reset_idempotency: false,
      reset_status: false, cancel_tombstone: false, paid_reset_by_user_id: false },
  } })
  vi.spyOn(bridge, 'callFakaV2ResolveAccount').mockImplementation(async no => ({ ok: true, httpStatus: 200, body: {
    success: true, protocol_version: 2, request_id: randomUUID(), queried_at: new Date().toISOString(),
    external_order_no: no, trade_no: `TRADE-${no}`, source_status: 'completed', account: { user_id: '42', email: 'changed@example.com' },
  } }))
  vi.spyOn(bridge, 'callFakaV2Subscription').mockImplementation(async id => ({ ok: true, httpStatus: 200, body: {
    success: true, protocol_version: 2, request_id: randomUUID(), queried_at: new Date().toISOString(),
    account: { user_id: id, email: 'changed@example.com' }, subscription: { status: 'active', plan_id: '3', plan_name: '测试套餐',
      total_bytes: '9223372036854775807', upload_bytes: '1', download_bytes: '2', used_bytes: '3', remaining_bytes: '9223372036854775804',
      expires_at: '0', next_reset_at: null, reset_count: '7' },
  } }))
  return () => {
    Object.assign(config.xboardAccounts, old.xboardAccounts)
    Object.assign(config.fakaBridge, old.fakaBridge)
    Object.assign(config.chatBot, old.chatBot)
    vi.restoreAllMocks()
    clearAccountQueryCachesForTests()
  }
}

export async function purchase(userId?: number) {
  const user = userId ? await prisma.user.findUniqueOrThrow({ where: { id: userId } })
    : await prisma.user.create({ data: { email: `${randomUUID()}@site.test`, password: 'unused', emailVerified: new Date('2026-01-01') } })
  const product = await prisma.product.create({ data: { name: 'B1 fixture', price: 100, type: '网络节点', categoryId: await getActiveNetworkNodeCategoryId() } })
  const email = `panel-${user.id}@example.com`
  await prisma.fakaProvisionEmailProof.upsert({ where: { userId_email: { userId: user.id, email } },
    create: { userId: user.id, email, verifiedAt: new Date('2026-01-01'), proofExpiresAt: null }, update: {} })
  const order = await prisma.order.create({ data: { userId: user.id, productId: product.id, price: 100, status: 'delivered', createdAt: new Date('2026-02-01') } })
  const no = `MN-${order.id}`
  const task = await prisma.fakaBridgeTask.create({ data: { orderId: order.id, status: 'succeeded', completedAt: new Date('2026-02-02'),
    requestOrderNo: no, xboardTradeNo: `TRADE-${no}`, emailSnapshot: email, skuSnapshot: 'test-monthly' } })
  await prisma.deliveryRecord.create({ data: { orderId: order.id, userId: user.id, productId: product.id, deliveredAt: new Date('2026-02-02') } })
  return { user, product, order, task, email }
}

export async function linked(userId?: number, remoteId = '42') {
  const p = await purchase(userId)
  await prisma.xboardInstance.upsert({ where: { id: instanceId }, create: { id: instanceId, origin: 'https://xboard.test' }, update: {} })
  const link = await prisma.xboardAccountLink.create({ data: { userId: p.user.id, instanceId, xboardUserId: remoteId,
    currentEmail: p.email, emailSnapshot: p.email, sourceOrderId: p.order.id, sourceExternalOrderNo: p.task.requestOrderNo } })
  const binding = await prisma.chatBinding.upsert({ where: { platform_userId: { platform: 'qq', userId: p.user.id } },
    create: { userId: p.user.id, platform: 'qq', platformId: String(100000 + p.user.id) }, update: {} })
  return { ...p, link, actor: { userId: p.user.id, bindingId: binding.id, platformId: binding.platformId } }
}
