import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { notFound } from '../../lib/httpError.js'
import { assertPermission } from '../adminAuthorization/service.js'
import {
  commandInTx,
  cursorPage,
  decodeCursor,
  writeGovernanceAudit,
} from '../governance/common.js'

type Snapshot = {
  userId: number
  balance: number
  frozenBalance: number
  lotAvailable: bigint
  lotFrozen: bigint
}
function snapshotQuery(lower: number, upper: number, onlyUser?: number) {
  return Prisma.sql`WITH selected AS (SELECT "userId",balance,"frozenBalance" FROM "PointAccount" WHERE "walletInitializedAt" IS NOT NULL AND "userId">${lower} AND "userId"<=${upper} ${onlyUser ? Prisma.sql`AND "userId"=${onlyUser}` : Prisma.empty} ORDER BY "userId" LIMIT 500)
    SELECT a."userId",a.balance,a."frozenBalance",COALESCE(SUM(l."availablePoints"),0)::bigint "lotAvailable",COALESCE(SUM(l."frozenPoints"),0)::bigint "lotFrozen"
    FROM selected a LEFT JOIN "PointLot" l ON l."userId"=a."userId" GROUP BY a."userId",a.balance,a."frozenBalance" ORDER BY a."userId"`
}
async function recordSnapshot(tx: Prisma.TransactionClient, row: Snapshot) {
  const now = new Date()
  for (const [type, accountValue, sourceValue] of [
    ['balance_source_mismatch', row.balance, row.lotAvailable],
    ['frozen_source_mismatch', row.frozenBalance, row.lotFrozen],
  ] as const) {
    if (BigInt(accountValue) !== sourceValue) {
      await tx.walletIntegrityIssue.upsert({
        where: { userId_type: { userId: row.userId, type } },
        create: {
          userId: row.userId,
          type,
          accountValue,
          sourceValue,
          status: 'open',
          lastVerifiedAt: now,
        },
        update: { accountValue, sourceValue, status: 'open', lastSeenAt: now, lastVerifiedAt: now },
      })
    } else {
      // An operator note never resolves a difference. Only a fresh aggregate can.
      await tx.walletIntegrityIssue.updateMany({
        where: { userId: row.userId, type },
        data: { accountValue, sourceValue, status: 'resolved', lastVerifiedAt: now },
      })
    }
  }
}
export function integrityIssueDto<T extends { sourceValue: bigint }>(r: T) {
  const sourceValue = Number(r.sourceValue)
  if (!Number.isSafeInteger(sourceValue)) throw Error('integrity_source_out_of_safe_range')
  return { ...r, sourceValue }
}
/** One bounded MVCC aggregate and an atomic checkpoint; restart resumes the existing run. */
export async function runIntegrityBatch(forceStart = false) {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('wallet-integrity-scan',0))`
      let run = await tx.walletIntegrityScanRun.findFirst({
        where: { status: 'running' },
        orderBy: { startedAt: 'asc' },
      })
      if (!run) {
        const last = await tx.walletIntegrityScanRun.findFirst({ orderBy: { startedAt: 'desc' } })
        if (!forceStart && last && last.startedAt.getTime() > Date.now() - 3600000) return null
        const upper = await tx.pointAccount.aggregate({ _max: { userId: true } })
        run = await tx.walletIntegrityScanRun.create({
          data: { upperUserId: upper._max.userId ?? 0 },
        })
      }
      const rows = await tx.$queryRaw<Snapshot[]>(snapshotQuery(run.cursorUserId, run.upperUserId))
      for (const row of rows) await recordSnapshot(tx, row)
      const done = rows.length < 500 || rows.at(-1)?.userId === run.upperUserId
      return tx.walletIntegrityScanRun.update({
        where: { id: run.id, cursorUserId: run.cursorUserId },
        data: {
          cursorUserId: done ? run.upperUserId : rows.at(-1)!.userId,
          scannedCount: { increment: rows.length },
          errorCode: null,
          ...(done ? { status: 'succeeded', completedAt: new Date() } : {}),
        },
      })
    },
    { timeout: 30000 },
  )
}
export async function listIntegrityRuns(actor: number, q: { cursor?: string; pageSize: number }) {
  await assertPermission(actor, 'wallet.integrity.read')
  const scope = 'integrity-runs',
    c = decodeCursor(q.cursor, scope, 'uuid')
  const rows = await prisma.walletIntegrityScanRun.findMany({
    where: c
      ? { OR: [{ startedAt: { lt: c.time } }, { startedAt: c.time, id: { lt: String(c.id) } }] }
      : {},
    orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
    take: q.pageSize + 1,
  })
  const page = cursorPage(
    rows.map((r) => ({ ...r, createdAt: r.startedAt })),
    q.pageSize,
    scope,
  )
  return { ...page, items: page.items.map(({ createdAt, ...r }) => r) }
}
export async function listIntegrityIssues(
  actor: number,
  q: { cursor?: string; pageSize: number; status?: 'open' | 'resolved' },
) {
  await assertPermission(actor, 'wallet.integrity.read')
  const scope = `integrity-issues:${q.status ?? 'all'}`,
    c = decodeCursor(q.cursor, scope, 'uuid')
  const rows = await prisma.walletIntegrityIssue.findMany({
    where: {
      status: q.status,
      ...(c
        ? { OR: [{ lastSeenAt: { lt: c.time } }, { lastSeenAt: c.time, id: { lt: String(c.id) } }] }
        : {}),
    },
    orderBy: [{ lastSeenAt: 'desc' }, { id: 'desc' }],
    take: q.pageSize + 1,
  })
  const page = cursorPage(
    rows.map((r) => ({ ...integrityIssueDto(r), createdAt: r.lastSeenAt })),
    q.pageSize,
    scope,
  )
  return { ...page, items: page.items.map(({ createdAt, ...r }) => r) }
}
export async function recheckIntegrityIssue(actor: number, id: string, key: string, note?: string) {
  await assertPermission(actor, 'wallet.integrity.read')
  return prisma.$transaction(async (tx) => {
    await assertPermission(actor, 'wallet.integrity.read', tx)
    return commandInTx(tx, actor, 'integrity.recheck', key, { id, note }, async () => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('wallet-integrity-scan',0))`
      const issue = await tx.walletIntegrityIssue.findUnique({ where: { id } })
      if (!issue) throw notFound('巡检差异不存在')
      const rows = await tx.$queryRaw<Snapshot[]>(snapshotQuery(0, issue.userId, issue.userId))
      if (!rows.length) throw notFound('账户尚未完成来源初始化，不能证明已修复')
      await recordSnapshot(tx, rows[0])
      if (note !== undefined)
        await tx.walletIntegrityIssue.update({ where: { id }, data: { note } })
      await writeGovernanceAudit(tx, actor, 'wallet.integrity.rechecked', 'user', issue.userId, {
        ...(note ? { note } : {}),
      })
      return integrityIssueDto(await tx.walletIntegrityIssue.findUniqueOrThrow({ where: { id } }))
    })
  })
}
