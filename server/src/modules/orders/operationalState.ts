import type { Prisma } from '@prisma/client'
import { listFulfillmentProviders } from '../fulfillment/registry.js'

/** Read-only operator queue; uncertain external work never implies permission to refund. */
export function fulfillmentReviewWhere(): Prisma.OrderWhereInput {
  const providers = listFulfillmentProviders()
  return {
  status: { in: ['pending', 'processing'] },
  OR: [
    { cancelRequestedAt: { not: null } },
    { fulfillmentJob: { status: 'needs_reconcile' } },
    ...providers.flatMap(provider => provider.operatorReviewWhere ? [provider.operatorReviewWhere] : []),
    { externalFulfillmentProvider: { not: null, notIn: providers.map(provider => provider.id) } },
    { status: 'processing', provisionTask: { attempts: { gt: 0 }, status: { not: 'succeeded' } } },
  ],
  }
}
