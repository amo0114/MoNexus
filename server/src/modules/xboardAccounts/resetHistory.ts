import { prisma } from '../../lib/prisma.js'
import { verifiedPaidExecution } from '../../lib/fakaBridge/paidResetV2.js'
import { paidResetPlanId } from '../../lib/fakaBridge/paidResetSku.js'

/** Count execution, including a later refund; never infer identity from an email or v1 task. */
export async function paidResetHistory(userId: number, link: { instanceId: string; origin: string; xboardUserId: string }) {
  const rows = await prisma.fakaBridgeTask.findMany({ where: { protocolVersion: 2,
    instanceIdSnapshot: link.instanceId, originSnapshot: link.origin, xboardUserIdSnapshot: link.xboardUserId,
    periodSnapshot: 'reset_traffic', order: { userId } }, orderBy: { id: 'desc' }, take: 1001,
    select: { requestOrderNo: true, xboardUserIdSnapshot: true, skuSnapshot: true, expectedPlanIdSnapshot: true,
      periodSnapshot: true, clientIdSnapshot: true, paidResetResult: true, createdAt: true } })
  const executions = new Set<string>()
  let coverageFrom: string | null = null
  for (const row of rows.slice(0, 1000)) {
    if (!row.clientIdSnapshot || paidResetPlanId(row.skuSnapshot) !== row.expectedPlanIdSnapshot) continue
    const proof = verifiedPaidExecution(row.paidResetResult, { order_no: row.requestOrderNo,
      user_id: row.xboardUserIdSnapshot!, sku: row.skuSnapshot, expected_plan_id: row.expectedPlanIdSnapshot!, period: 'reset_traffic' }, row.clientIdSnapshot)
    if (!proof) continue
    // External order is scoped by the frozen commercial client and stable instance.
    executions.add(row.requestOrderNo)
    const date = row.createdAt.toISOString()
    if (coverageFrom === null || date < coverageFrom) coverageFrom = date
  }
  return { successful: executions.size, truncated: rows.length > 1000, coverageFrom }
}
