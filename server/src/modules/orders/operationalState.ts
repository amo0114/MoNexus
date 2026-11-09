import type { Prisma } from '@prisma/client'

/** Read-only operator queue; uncertain external work never implies permission to refund. */
export const FULFILLMENT_REVIEW_WHERE: Prisma.OrderWhereInput = {
  status: { in: ['pending', 'processing'] },
  OR: [
    { cancelRequestedAt: { not: null } },
    { fulfillmentJob: { status: 'needs_reconcile' } },
    { fakaBridgeTask: { OR: [{ status: 'needs_reconcile' }, { revokeStatus: 'failed' }] } },
    { status: 'processing', provisionTask: { attempts: { gt: 0 }, status: { not: 'succeeded' } } },
  ],
}
