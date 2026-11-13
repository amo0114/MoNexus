import { assertMerchantOperation } from '../merchantGovernance/capability.js'
import type { Prisma } from '@prisma/client'
/** Transaction-local metadata; the DB whitelist trigger captures all authoritative writers. */
export async function setCommercialActor(
  tx: Prisma.TransactionClient,
  actor: { adminUserId: number } | { merchantId: number },
  source: string,
) {
  if ('merchantId' in actor)
    await assertMerchantOperation(tx, actor.merchantId, true, source !== 'merchant/webhookConfig')
  const userId =
    'adminUserId' in actor
      ? actor.adminUserId
      : (
          await tx.merchant.findUniqueOrThrow({
            where: { id: actor.merchantId },
            select: { userId: true },
          })
        ).userId
  await tx.$executeRaw`SELECT set_config('monexus.commercial_actor', ${String(userId)}, true), set_config('monexus.commercial_source', ${source}, true), set_config('monexus.commercial_reason', 'commercial_update', true)`
}
