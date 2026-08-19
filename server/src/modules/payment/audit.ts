import { prisma } from '../../lib/prisma.js'

const MAX_DETAIL_CHARS = 240

export async function writePaymentAdminLog(input: {
  adminUserId: number
  action: string
  targetType: string
  targetKey: string
  extra?: Record<string, string | number | boolean | null>
}) {
  const payload = {
    targetKey: input.targetKey,
    ...input.extra,
  }
  let detail = JSON.stringify(payload)
  if (detail.length > MAX_DETAIL_CHARS) {
    detail = `${detail.slice(0, MAX_DETAIL_CHARS)}…`
  }
  await prisma.adminLog.create({
    data: {
      adminUserId: input.adminUserId,
      action: input.action,
      targetType: input.targetType,
      detail,
    },
  })
}
