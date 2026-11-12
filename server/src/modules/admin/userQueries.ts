import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { badRequest, notFound } from '../../lib/httpError.js'
import { accountStatus, effectiveBanWhere, legacyStatus } from '../accountGovernance/status.js'
import { assertPermission, authorization } from '../adminAuthorization/service.js'
import { accountSources } from '../wallet/index.js'
import { cursorPage, decodeCursor } from '../governance/common.js'
import { serializeBan } from '../accountGovernance/service.js'

export type UserListQuery = {
  page?: number
  pageSize?: number
  q?: string
  accountStatus?: 'active' | 'banned'
  role?: string
  merchantStatus?: string
  emailVerified?: boolean
  registeredFrom?: string
  registeredTo?: string
  lastLoginFrom?: string
  lastLoginTo?: string
  sort?: 'createdAt' | 'lastLoginAt' | 'orderCount' | 'netSpentPoints'
  direction?: 'asc' | 'desc'
}
export function orderStatsQuery(restriction = Prisma.empty) {
  return Prisma.sql`
  SELECT o."userId", COUNT(*)::int AS "orderCount",
    COALESCE(SUM(w.charged),0)::bigint AS "chargedPoints", COALESCE(SUM(w.refunded),0)::bigint AS "refundedPoints",
    COUNT(*) FILTER (WHERE o.status IN ('delivered','completed','closed','disputed','refunded') AND COALESCE(w.charged,0)=0)::int AS "unprovenCount"
  FROM "Order" o
  LEFT JOIN LATERAL (SELECT COALESCE(SUM(amount) FILTER (WHERE kind IN ('spend','capture')),0)::bigint charged,
    COALESCE(SUM(amount) FILTER (WHERE kind IN ('refund','legacy_refund')),0)::bigint refunded
    FROM "WalletOperation" wo WHERE wo."sourceKind"='order' AND wo."sourceId"=o.id::text AND wo."userId"=o."userId") w ON TRUE
  ${restriction}
  GROUP BY o."userId"`
}
export function statsDto(row: {
  orderCount?: number
  chargedPoints?: bigint | number
  refundedPoints?: bigint | number
  unprovenCount?: number
}) {
  const chargedPoints = Number(row.chargedPoints ?? 0),
    refundedPoints = Number(row.refundedPoints ?? 0)
  if (!Number.isSafeInteger(chargedPoints) || !Number.isSafeInteger(refundedPoints))
    throw new Error('governance_stats_out_of_safe_range')
  return {
    orderCount: row.orderCount ?? 0,
    chargedPoints,
    refundedPoints,
    netSpentPoints: chargedPoints - refundedPoints,
    legacyCompleteness: row.unprovenCount ? (chargedPoints ? 'partial' : 'unknown') : 'complete',
  }
}
export async function listGovernanceUsers(actor: number, q: UserListQuery) {
  await assertPermission(actor, 'users.read')
  const page = q.page ?? 1,
    pageSize = Math.min(q.pageSize ?? 20, 100)
  const clauses: Prisma.Sql[] = [Prisma.sql`TRUE`]
  if (q.accountStatus)
    clauses.push(Prisma.sql`governance_user_active(u.id) = ${q.accountStatus === 'active'}`)
  if (q.role) clauses.push(Prisma.sql`u.role=${q.role}`)
  if (q.merchantStatus) clauses.push(Prisma.sql`m.status=${q.merchantStatus}`)
  if (q.emailVerified !== undefined)
    clauses.push(
      q.emailVerified
        ? Prisma.sql`u."emailVerified" IS NOT NULL`
        : Prisma.sql`u."emailVerified" IS NULL`,
    )
  for (const [key, col, lower] of [
    ['registeredFrom', 'createdAt', true],
    ['registeredTo', 'createdAt', false],
    ['lastLoginFrom', 'lastLoginAt', true],
    ['lastLoginTo', 'lastLoginAt', false],
  ] as const) {
    if (q[key])
      clauses.push(
        lower
          ? Prisma.sql`${Prisma.raw(`u."${col}"`)} >= ${new Date(q[key]!)}`
          : Prisma.sql`${Prisma.raw(`u."${col}"`)} < ${new Date(q[key]!)}`,
      )
  }
  if (q.q) {
    const text = q.q.trim()
    if (/^\d+$/.test(text) && Number.isSafeInteger(Number(text)))
      clauses.push(Prisma.sql`u.id=${Number(text)}`)
    else if (text.includes('@')) clauses.push(Prisma.sql`u.email=${text.toLowerCase()}`)
    else {
      const term = `%${text.replace(/[\\%_]/g, '\\$&')}%`
      clauses.push(
        Prisma.sql`(u.email ILIKE ${term} OR u.nickname ILIKE ${term} OR m.name ILIKE ${term})`,
      )
    }
  }
  const where = Prisma.join(clauses, ' AND ')
  const sort = {
    createdAt: 'u."createdAt"',
    lastLoginAt: 'u."lastLoginAt"',
    orderCount: 'COALESCE(s."orderCount",0)',
    netSpentPoints: '(COALESCE(s."chargedPoints",0)-COALESCE(s."refundedPoints",0))',
  }[q.sort ?? 'createdAt']
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SET LOCAL statement_timeout = '5000ms'`
      const total = await tx.$queryRaw<
        Array<{ total: bigint }>
      >`SELECT COUNT(*) total FROM "User" u LEFT JOIN "Merchant" m ON m."userId"=u.id WHERE ${where}`
      const rows = await tx.$queryRaw<
        Array<{
          id: number
          email: string
          nickname: string | null
          role: string
          emailVerified: Date | null
          createdAt: Date
          lastLoginAt: Date | null
          merchantStatus: string | null
          isActive: boolean
          balance: number | null
          orderCount: number
          chargedPoints: bigint
          refundedPoints: bigint
          unprovenCount: number
        }>
      >`
      WITH selected AS MATERIALIZED (
        SELECT u.id,u.email,u.nickname,u.role,u."emailVerified",u."createdAt",u."lastLoginAt",m.status "merchantStatus",pa.balance
        FROM "User" u LEFT JOIN "Merchant" m ON m."userId"=u.id LEFT JOIN "PointAccount" pa ON pa."userId"=u.id
        WHERE ${where}
        ${['orderCount', 'netSpentPoints'].includes(q.sort ?? '') ? Prisma.empty : Prisma.sql`ORDER BY ${Prisma.raw(sort)} ${Prisma.raw(q.direction === 'asc' ? 'ASC' : 'DESC')} NULLS LAST,u.id DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`}
      ), stats AS (${orderStatsQuery(Prisma.sql`WHERE o."userId" IN (SELECT id FROM selected)`)})
      SELECT u.*,governance_user_active(u.id) "isActive",s."orderCount",s."chargedPoints",s."refundedPoints",s."unprovenCount"
      FROM selected u LEFT JOIN stats s ON s."userId"=u.id
      ORDER BY ${Prisma.raw(sort)} ${Prisma.raw(q.direction === 'asc' ? 'ASC' : 'DESC')} NULLS LAST, u.id DESC
      ${['orderCount', 'netSpentPoints'].includes(q.sort ?? '') ? Prisma.sql`LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}` : Prisma.empty}`
      return {
        items: rows.map(({ isActive, balance, unprovenCount, ...u }) => ({
          ...u,
          ...statsDto({ ...u, unprovenCount }),
          accountStatus: isActive ? 'active' : 'banned',
          status: isActive ? '正常' : '已封禁',
          pointAccount: balance === null ? null : { balance },
        })),
        total: Number(total[0].total),
        page,
        pageSize,
      }
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  )
}
export async function userDetail(actor: number, userId: number) {
  const auth = await assertPermission(actor, 'users.read')
  return prisma.$transaction(
    async (tx) => {
      const u = await tx.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          email: true,
          nickname: true,
          avatarUrl: true,
          role: true,
          emailVerified: true,
          createdAt: true,
          updatedAt: true,
          lastLoginAt: true,
          merchant: { select: { id: true, name: true, status: true, lifecycleVersion: true } },
        },
      })
      if (!u) throw notFound('用户不存在')
      const status = await accountStatus(userId, tx)
      const ban = await tx.accountBan.findFirst({ where: { userId, ...effectiveBanWhere() } })
      const sourcesAllowed = auth.permissions.includes('points.read')
      const account = sourcesAllowed
        ? await tx.pointAccount.findUnique({ where: { userId } })
        : null
      const stats = auth.permissions.includes('orders.read')
        ? ((
            await tx.$queryRaw<
              Array<Parameters<typeof statsDto>[0]>
            >`${orderStatsQuery(Prisma.sql`WHERE o."userId"=${userId}`)}`
          )[0] ?? {})
        : null
      const [inviter, inviteeCount, session, activeDay] = await Promise.all([
        tx.inviteRelation.findFirst({ where: { inviteeId: userId }, select: { inviterId: true } }),
        tx.inviteRelation.count({ where: { inviterId: userId } }),
        tx.refreshToken.findFirst({
          where: { userId },
          select: { lastUsedAt: true },
          orderBy: { lastUsedAt: 'desc' },
        }),
        tx.userActiveDay.findFirst({ where: { userId }, orderBy: { day: 'desc' } }),
      ])
      const { merchant, ...identity } = u
      return {
        user: { ...identity, accountStatus: status, status: legacyStatus(status) },
        ban: ban ? serializeBan(ban) : null,
        merchant,
        wallet: account
          ? {
              balance: account.balance,
              frozenBalance: account.frozenBalance,
              sources: (await accountSources(tx, userId)).map((s) => ({
                origin: s.origin,
                availablePoints: s.available,
                frozenPoints: s.frozen,
              })),
            }
          : null,
        stats: stats ? statsDto(stats) : null,
        invites: { inviterUserId: inviter?.inviterId ?? null, inviteeCount },
        activity: {
          lastLoginAt: u.lastLoginAt,
          lastSessionUsedAt: session?.lastUsedAt ?? null,
          lastActiveDay: activeDay?.day ?? null,
        },
        sections: {
          orders: auth.permissions.includes('orders.read'),
          pointLogs: sourcesAllowed,
          sessions: true,
          referrals: true,
          securityEvents: auth.permissions.includes('audit.details.read'),
          audit: auth.permissions.includes('audit.read'),
        },
        asOf: new Date().toISOString(),
      }
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  )
}
export async function userSection(
  actor: number,
  userId: number,
  section: string,
  query: { cursor?: string; pageSize: number },
) {
  const permissions = {
    orders: 'orders.read',
    'point-logs': 'points.read',
    sessions: 'users.read',
    referrals: 'users.read',
    'security-events': 'audit.details.read',
    audit: 'audit.read',
    bans: 'users.ban',
  } as const
  const permission = permissions[section as keyof typeof permissions]
  if (!permission) throw notFound()
  await assertPermission(actor, permission)
  if (!(await prisma.user.findUnique({ where: { id: userId }, select: { id: true } })))
    throw notFound('用户不存在')
  const scope = `user:${userId}:${section}`,
    c = decodeCursor(
      query.cursor,
      scope,
      section === 'sessions' || section === 'bans' ? 'uuid' : 'integer',
    ),
    size = query.pageSize
  if (
    c &&
    (section === 'bans' || section === 'sessions'
      ? !/^[0-9a-f-]{36}$/i.test(String(c.id))
      : !Number.isSafeInteger(Number(c.id)) || Number(c.id) <= 0)
  )
    throw badRequest('分页游标无效')
  const after = c
    ? { OR: [{ createdAt: { lt: c.time } }, { createdAt: c.time, id: { lt: Number(c.id) } }] }
    : {}
  const afterUuid = c
    ? { OR: [{ createdAt: { lt: c.time } }, { createdAt: c.time, id: { lt: String(c.id) } }] }
    : {}
  let rows: any[] = []
  if (section === 'orders') {
    const orders = await prisma.order.findMany({
      where: { userId, ...after },
      select: {
        id: true,
        orderNo: true,
        productNameSnapshot: true,
        product: { select: { name: true } },
        status: true,
        price: true,
        createdAt: true,
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: size + 1,
    })
    const ops = orders.length
      ? await prisma.walletOperation.findMany({
          where: {
            userId,
            sourceKind: 'order',
            sourceId: { in: orders.map((o) => String(o.id)) },
            kind: { in: ['spend', 'capture', 'refund', 'legacy_refund'] },
          },
          select: { sourceId: true, kind: true, amount: true },
        })
      : []
    rows = orders.map(({ product, productNameSnapshot, status, ...o }) => ({
      ...o,
      status: status === 'completed' ? 'delivered' : status,
      productName: productNameSnapshot ?? product.name,
      chargedPoints: ops
        .filter((x) => x.sourceId === String(o.id) && ['spend', 'capture'].includes(x.kind))
        .reduce((n, x) => n + x.amount, 0),
      refundedPoints: ops
        .filter((x) => x.sourceId === String(o.id) && ['refund', 'legacy_refund'].includes(x.kind))
        .reduce((n, x) => n + x.amount, 0),
    }))
  } else if (section === 'point-logs') {
    const logs = await prisma.pointLog.findMany({
      where: { userId, ...after },
      include: { walletOperation: { select: { id: true, kind: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: size + 1,
    })
    rows = logs.map(({ walletOperation, growthEligible, ...r }) => ({
      ...r,
      operationId: walletOperation?.id ?? null,
      origin: null,
    }))
  } else if (section === 'sessions') {
    rows = await prisma.$queryRaw<Array<{ id: string; createdAt: Date }>>`WITH families AS (
      SELECT "sessionId"::text id, MIN("sessionStartedAt") "createdAt", MAX("lastUsedAt") "lastUsedAt", MAX("expiresAt") "expiresAt", BOOL_AND(revoked) revoked,
      NULL::text "deviceName" FROM "RefreshToken" WHERE "userId"=${userId} GROUP BY "sessionId")
      SELECT * FROM families ${c ? Prisma.sql`WHERE ("createdAt",id)<(${c.time},${String(c.id)})` : Prisma.empty} ORDER BY "createdAt" DESC,id DESC LIMIT ${size + 1}`
  } else if (section === 'referrals') {
    const relations = await prisma.inviteRelation.findMany({
      where: { OR: [{ inviteeId: userId }, { inviterId: userId }], AND: after },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: size + 1,
    })
    rows = relations.map((r) => ({
      id: r.id,
      inviterUserId: r.inviterId,
      inviteeUserId: r.inviteeId,
      status: r.status,
      createdAt: r.createdAt,
    }))
  } else if (section === 'security-events')
    rows = await prisma.securityEvent.findMany({
      where: { userId, ...after },
      select: { id: true, type: true, createdAt: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: size + 1,
    })
  else if (section === 'audit') {
    const logs = await prisma.adminLog.findMany({
      where: { targetType: 'user', targetId: userId, ...after },
      select: {
        id: true,
        adminUserId: true,
        action: true,
        actionCode: true,
        targetType: true,
        targetId: true,
        createdAt: true,
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: size + 1,
    })
    rows = logs.map(({ adminUserId, ...r }) => ({ ...r, adminId: adminUserId }))
  } else if (section === 'bans')
    rows = (
      await prisma.accountBan.findMany({
        where: { userId, ...afterUuid },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: size + 1,
      })
    ).map(serializeBan)
  return cursorPage(rows, size, scope)
}
