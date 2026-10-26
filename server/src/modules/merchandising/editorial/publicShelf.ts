import { Prisma } from '@prisma/client'
import { prisma } from '../../../lib/prisma.js'
import {
  CATEGORY_GUEST_VISIBILITY,
  guestVisibleProductIdsSql,
  isCurrentlyPubliclyVisible,
  type ProductAudience,
} from '../../products/visibility.js'

export async function listEditorialShelf(
  input: { placement?: string; categoryCode?: string; limit?: number } = {},
  audience: ProductAudience = 'guest',
  queryTime?: Date,
) {
  const now = queryTime ?? (await prisma.$queryRaw<Array<{ now: Date }>>`SELECT now() AT TIME ZONE 'UTC' AS now`)[0].now
  // Prisma cannot compare reviewedRevision on the related eligibility row
  // with publicContentRevision. Select exact visible feature IDs before LIMIT;
  // filtering after LIMIT would let outdated approvals consume every slot.
  const guestIds = audience === 'guest' ? await prisma.$queryRaw<Array<{ id: number }>>(Prisma.sql`
    SELECT f."id" FROM "EditorialFeature" f
    WHERE f."status" = 'active' AND f."startsAt" <= ${now} AND f."endsAt" > ${now}
      ${input.placement ? Prisma.sql`AND f."placement" = ${input.placement}` : Prisma.empty}
      AND f."productId" IN ${guestVisibleProductIdsSql(
        input.categoryCode ? Prisma.sql`c."code" = ${input.categoryCode}` : undefined,
      )}
    ORDER BY f."sortWeight" DESC, f."id" DESC
    LIMIT ${input.limit ?? 6}
  `) : undefined
  if (guestIds?.length === 0) return []
  const rows = await prisma.editorialFeature.findMany({
    where: {
      ...(guestIds ? { id: { in: guestIds.map(row => row.id) } } : {}),
      status: 'active',
      startsAt: { lte: now },
      endsAt: { gt: now },
      ...(input.placement ? { placement: input.placement } : {}),
      product: {
        status: 'active',
        archivedAt: null,
        // SPEC-CATALOG-VIS-001 §3.4（P1-B）：游客查询阶段就排除受限分类。
        // 后续 isCurrentlyPubliclyVisible 会二次过滤，但那发生在 take 之后——
        // 受限分类的 feature 先占名额再被丢弃，游客看到的卡片数会少于
        // limit。查询条件补上分类门后名额才准。
        ...(audience === 'guest'
          ? {
              visibility: 'public',
            }
          : {}),
        ...((input.categoryCode || audience === 'guest') ? {
          category: { is: {
            ...(input.categoryCode ? { code: input.categoryCode } : {}),
            ...(audience === 'guest' ? { guestVisibility: CATEGORY_GUEST_VISIBILITY.PUBLIC } : {}),
          } },
        } : {}),
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
          // SPEC-CATALOG-VIS-001 §3.3：访问判定需要分类可见性，
          // 缺字段会让 PublicProductAccessRow 类型检查失败（不默认公开）。
          category: { select: { guestVisibility: true } },
          // SPEC-CATALOG-VIS-001 §4.2（P1.5）：准入判定需要当前版本 + 准入记录。
          publicContentRevision: true,
          guestEligibility: { select: { decision: true, reviewedRevision: true } },
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
