import { parseArgs } from 'node:util'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { processResetOperation } from '../modules/trafficReset/worker.js'
try {
  const { values } = parseArgs({ strict: true, allowPositionals: false, options: {
    'admin-user-id': { type: 'string' }, operation: { type: 'string' }, cancel: { type: 'boolean', default: false }, reason: { type: 'string' }, apply: { type: 'boolean', default: false },
  } })
  const id = z.string().uuid().parse(values.operation)
  const row = await prisma.xboardTrafficResetOperation.findUniqueOrThrow({ where: { id } })
  if (values.cancel && (!values.reason || values.reason.length < 8 || values.reason.length > 200)) throw new Error('cancellation requires an audit reason (8..200 characters)')
  const adminId = values.cancel ? z.coerce.number().int().positive().parse(values['admin-user-id']) : null
  if (adminId !== null && !await prisma.user.findFirst({ where: { id: adminId, role: 'admin', status: '正常' } })) throw new Error('valid administrator required')
  if (values.apply) {
    if (values.cancel) {
      await prisma.$transaction(async tx => {
        // This is a protected operator CLI, never a public HTTP action. Persist
        // its audit reason atomically with the cancellation request.
        await tx.adminLog.create({ data: { adminUserId: adminId!, action: 'system.traffic_reset.cancel_request', targetType: 'XboardTrafficResetOperation',
          detail: JSON.stringify({ operationId: id, reason: values.reason! }) } })
        await tx.xboardTrafficResetOperation.updateMany({ where: { id, status: { in: ['queued','sending','needs_reconcile'] } },
          data: { cancelRequested: true, nextAttemptAt: new Date() } })
      })
    }
    await prisma.xboardTrafficResetOperation.updateMany({ where: { id, status: { in: ['queued','sending','needs_reconcile'] } }, data: { nextAttemptAt: new Date() } })
    await processResetOperation(id)
  }
  const result = await prisma.xboardTrafficResetOperation.findUniqueOrThrow({ where: { id } })
  console.log(JSON.stringify({ apply: values.apply, operationId: id, status: result.status, cancelRequested: result.cancelRequested, previousStatus: row.status }))
} catch { console.error('Reset recovery failed; check operation, dependencies and explicit --apply/--cancel/--reason arguments.'); process.exitCode = 1 }
finally { await prisma.$disconnect() }
