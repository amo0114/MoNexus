import { prisma } from '../../../lib/prisma.js'
import {
  isCurrentlyPubliclyVisible,
  type ProductAudience,
} from '../../products/visibility.js'

export async function listEditorialShelf(
  input: { placement?: string; limit?: number } = {},
  audience: ProductAudience = 'guest',
) {
  const [{ now }] = await prisma.$queryRaw<Array<{ now: Date }>>`SELECT now() AT TIME ZONE 'UTC' AS now`
  const rows = await prisma.editorialFeature.findMany({
    where: {
      status: 'active',
      startsAt: { lte: now },
      endsAt: { gt: now },
      ...(input.placement ? { placement: input.placement } : {}),
      product: {
        status: 'active',
        archivedAt: null,
        ...(audience === 'guest' ? { visibility: 'public' } : {}),
        OR: [{ merchantId: null }, { merchant: { status: 'active' } }],
      },
    },
    select: {
      productId: true,
      placement: true,
      publicReason: true,
      product: {
        select: {
          status: true,
          archivedAt: true,
          visibility: true,
          merchantId: true,
          merchant: { select: { status: true } },
        },
      },
    },
    orderBy: [{ sortWeight: 'desc' }, { id: 'desc' }],
    take: input.limit ?? 6,
  })
  return rows
    .filter(row => isCurrentlyPubliclyVisible(row.product, audience))
    .map(({ product: _product, ...row }) => ({ ...row, label: '平台精选' as const }))
}
