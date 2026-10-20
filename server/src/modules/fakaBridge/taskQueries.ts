import type { Prisma } from '@prisma/client'

export function countOpenFakaTasksForOffer(
  db: Pick<Prisma.TransactionClient, 'fakaBridgeTask'>,
  offerId: number,
) {
  return db.fakaBridgeTask.count({
    where: {
      order: { offerId },
      OR: [
        { status: { in: ['pending', 'needs_reconcile'] } },
        { revokeStatus: 'pending' },
      ],
    },
  })
}
