import { prisma } from '../../../lib/prisma.js'

export async function listEditorialShelf(input: { placement?: string; limit?: number } = {}) {
  const [{ now }] = await prisma.$queryRaw<Array<{ now: Date }>>`SELECT now() AT TIME ZONE 'UTC' AS now`
  const rows = await prisma.editorialFeature.findMany({
    where: {
      status: 'active',
      startsAt: { lte: now },
      endsAt: { gt: now },
      ...(input.placement ? { placement: input.placement } : {}),
      product: {
        status: 'active',
        OR: [{ merchantId: null }, { merchant: { status: 'active' } }],
      },
    },
    select: { productId: true, placement: true, publicReason: true },
    orderBy: [{ sortWeight: 'desc' }, { id: 'desc' }],
    take: input.limit ?? 6,
  })
  return rows.map(row => ({ ...row, label: '平台精选' as const }))
}
