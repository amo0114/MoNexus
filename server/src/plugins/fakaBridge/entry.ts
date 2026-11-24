import type { Prisma } from '@prisma/client'
import type { OptionalFulfillmentPlugin } from '../../extension-contracts/optionalFulfillment.js'
import { conflict } from '../../lib/httpError.js'
import { prisma } from '../../lib/prisma.js'
import { fakaRuntimeMiddleware } from '../../lib/runtimeSettings/fakaBridge.js'
import { fakaAdminRoutes } from '../../modules/admin/fakaRoutes.js'
import { xboardBotRoutes } from '../../modules/chatbot/xboard/routes.js'
import { xboardFulfillmentProvider } from '../../modules/fakaBridge/provider.js'
import { fakaBridgeRoutes } from '../../modules/fakaBridge/routes.js'

async function assertReady() {
  const [schema] = await prisma.$queryRaw<Array<{ ready: boolean }>>`
    SELECT to_regclass('"FakaBridgeTask"') IS NOT NULL
       AND to_regclass('"XboardTrafficResetOperation"') IS NOT NULL
       AND to_regclass('"TrafficResetBenefitGrant"') IS NOT NULL AS ready
  `
  if (!schema?.ready) throw conflict('请先安装插件数据库迁移')
}

async function assertDetachable(tx: Prisma.TransactionClient) {
  const now = new Date()
  const [task, reset, benefit] = await Promise.all([
    tx.fakaBridgeTask.findFirst({ where: { OR: [
      { status: { in: ['pending', 'needs_reconcile'] } },
      { revokeStatus: { in: ['pending', 'failed'] } },
      { leaseUntil: { gt: now } },
      { order: { OR: [{ status: 'disputed' }, { afterSalesCases: { some: { status: 'open' } } }] } },
      { revokeStatus: null, order: { status: 'refunded' },
        OR: [{ status: 'succeeded' }, { status: 'failed', xboardTradeNo: { not: null } }] },
      { status: 'succeeded', periodSnapshot: { not: 'reset_traffic' }, AND: [
        { OR: [{ revokeStatus: null }, { revokeStatus: { not: 'succeeded' } }] },
        { order: { OR: [{ delivery: null }, { delivery: { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] } }] } },
      ] },
    ] }, select: { id: true } }),
    tx.xboardTrafficResetOperation.findFirst({ where: { OR: [
      { status: { in: ['queued', 'sending', 'needs_reconcile'] } },
      { leaseUntil: { gt: now } },
    ] }, select: { id: true } }),
    tx.trafficResetBenefitGrant.findFirst({ where: {
      status: 'active', consumed: { lt: tx.trafficResetBenefitGrant.fields.granted },
    }, select: { id: true } }),
  ])
  if (task || reset || benefit) throw conflict('仍有未处理的外部任务、售后或有效权益，不能注销插件')
}

export const plugin = {
  contractVersion: 1,
  provider: xboardFulfillmentProvider,
  runtimeContext: fakaRuntimeMiddleware,
  buyerRoutes: fakaBridgeRoutes,
  rawBotRoutes: xboardBotRoutes,
  adminRoutes: fakaAdminRoutes,
  assertReady,
  assertDetachable,
} satisfies OptionalFulfillmentPlugin
