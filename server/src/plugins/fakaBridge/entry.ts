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
    SELECT bool_and(to_regclass(quote_ident(name)) IS NOT NULL) AS ready
    FROM unnest(ARRAY[
      'FakaBridgeTask', 'FakaProvisionEmailProof', 'FakaProvisionEmailSendBudget', 'ExternalCatalogSyncIdempotency',
      'XboardInstance', 'XboardAccountLink', 'XboardAccountEvidence', 'XboardAccountPreference',
      'XboardAccountSelection', 'XboardAccountBackfillState', 'XboardTrafficResetOperation',
      'TrafficResetBenefitGrant', 'TrafficResetIntent', 'TrafficResetConfirmationRequest'
    ]) AS required(name)
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
      { revokeStatus: null, status: 'failed', xboardTradeNo: { not: null } },
      { revokeStatus: null, status: 'succeeded', order: { status: 'refunded' } },
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
      status: { in: ['active', 'pending_verification'] }, consumed: { lt: tx.trafficResetBenefitGrant.fields.granted },
    }, select: { id: true } }),
  ])
  const blockers = [
    task ? '外部履约、撤销或售后' : null,
    reset ? '流量重置操作' : null,
    benefit ? '未消费或待核验的权益' : null,
  ].filter(Boolean)
  if (blockers.length) throw conflict(`仍有待处理的${blockers.join('、')}，不能注销插件`)
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
