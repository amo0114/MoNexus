import 'dotenv/config'
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Prisma } from '@prisma/client'
import { prisma } from '../lib/prisma.js'
import { businessNumber } from '../lib/businessNumber.js'
import { findWalletInvariantViolations } from '../modules/wallet/queries.js'
import { lockUserRefreshSessionMutations } from '../modules/auth/sessionService.js'
import { getDeliveryStorageForWrite } from '../lib/storage/delivery.js'
import { DeliveryMemoryStorage } from '../lib/storage/deliveryMemory.js'

const entities = [
  'Order',
  'SettlementBatch',
  'OrderAfterSalesCase',
  'User',
  'OrderStatus',
  'Merchant',
  'Offer',
] as const
type Entity = (typeof entities)[number]
type Options = {
  phase: 'preflight' | 'backfill' | 'finalize' | 'verify'
  dryRun: boolean
  batchSize: number
  resumeAfterId: number
  entity?: Entity
  report?: string
  maintenance?: boolean
}
const json = (value: unknown) =>
  JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2)
const finalChecks = [
  'User_governance_status_check',
  'User_governance_role_check',
  'Merchant_governance_status_check',
  'Order_governance_status_check',
  'Order_governance_number_check',
  'SettlementBatch_governance_number_check',
  'OrderAfterSalesCase_governance_number_check',
]
async function structureCheck() {
  const source = await readFile(
    new URL('../../prisma/post-deploy/governance-v1-indexes.sql', import.meta.url),
    'utf8',
  )
  const expected = source
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
  const rows = await prisma.$queryRaw<
    Array<{ name: string; valid: boolean; definition: string }>
  >`SELECT c.relname name, i.indisvalid valid, pg_get_indexdef(c.oid) definition FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema()`
  const normalize = (v: string) =>
    v
      .replace(/CONCURRENTLY |IF NOT EXISTS |public\.| USING btree/g, '')
      .replace(/\s+/g, '')
      .replace(/"/g, '')
      .toLowerCase()
  const invalidIndexes = expected.flatMap((statement) => {
    const name = statement.match(/IF NOT EXISTS "([^"]+)"/)![1]
    const actual = rows.find((r) => r.name === name)
    return !actual?.valid || normalize(actual.definition) !== normalize(statement) ? [name] : []
  })
  const constraints = await prisma.$queryRaw<
    Array<{ name: string; validated: boolean }>
  >`SELECT conname name, convalidated validated FROM pg_constraint WHERE connamespace=current_schema()::regnamespace AND conname IN (${Prisma.join(finalChecks)})`
  return {
    invalidIndexes,
    missingFinalChecks: finalChecks.filter(
      (name) => !constraints.some((c) => c.name === name && c.validated),
    ),
  }
}

const tables = [
  ['Order', 'orderNo', 'MN'],
  ['SettlementBatch', 'batchNo', 'MNSB'],
  ['OrderAfterSalesCase', 'caseNo', 'MNAS'],
] as const
export async function governancePreflight() {
  const states = await prisma.$queryRaw<
    Array<{ entity: string; value: string; count: bigint }>
  >`SELECT 'user.status' entity,status value,COUNT(*) count FROM "User" GROUP BY status UNION ALL SELECT 'user.role',role,COUNT(*) FROM "User" GROUP BY role UNION ALL SELECT 'merchant.status',status,COUNT(*) FROM "Merchant" GROUP BY status UNION ALL SELECT 'order.status',status,COUNT(*) FROM "Order" GROUP BY status`
  const allowed: Record<string, string[]> = {
    'user.status': ['active', 'banned', '正常', '已封禁'],
    'user.role': ['user', 'merchant', 'admin'],
    'merchant.status': ['pending', 'active', 'rejected', 'suspended'],
    'order.status': [
      'pending',
      'processing',
      'delivered',
      'completed',
      'disputed',
      'closed',
      'refunded',
    ],
  }
  const unknown = states.filter((s) => !allowed[s.entity].includes(s.value))
  const [numbers, roles, admins, unknownSources, legacyInventory, violations, cutover] =
    await Promise.all([
      Promise.all(
        tables.map(async ([table, field]) => ({
          table,
          missing: Number(
            (
              await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
                `SELECT COUNT(*) n FROM "${table}" WHERE "${field}" IS NULL`,
              )
            )[0].n,
          ),
        })),
      ),
      prisma.$queryRaw<
        Array<{ merchantId: number; userId: number; role: string; status: string }>
      >`SELECT m.id "merchantId",u.id "userId",u.role,m.status FROM "Merchant" m JOIN "User" u ON u.id=m."userId" WHERE u.role='admin' OR (m.status='active' AND u.role<>'merchant') OR (u.role='merchant' AND m.status IN ('pending','rejected'))`,
      prisma.user.findMany({
        where: { role: 'admin' },
        select: {
          id: true,
          createdAt: true,
          adminAuthorization: { select: { tier: true, version: true } },
        },
        orderBy: { id: 'asc' },
      }),
      prisma.$queryRaw<
        Array<{ n: bigint }>
      >`SELECT COUNT(*) n FROM "RechargeOrder" r WHERE r.status='credited' AND NOT EXISTS (SELECT 1 FROM "WalletOperation" w WHERE w."operationKey"='recharge-credit:'||r.id::text)`,
      prisma.inventoryItem.count({ where: { batchId: null } }),
      findWalletInvariantViolations(),
      prisma.$queryRaw<
        Array<{ at: Date }>
      >`SELECT finished_at at FROM _prisma_migrations WHERE migration_name='20261112120000_backend_governance' AND finished_at IS NOT NULL LIMIT 1`,
    ])
  let storage: { durable: boolean; providerConfigId: number | null; verified: boolean }
  try {
    const s = await getDeliveryStorageForWrite()
    storage = {
      durable: !(s.adapter instanceof DeliveryMemoryStorage),
      providerConfigId: s.providerConfigId,
      verified: true,
    }
  } catch {
    storage = { durable: false, providerConfigId: null, verified: false }
  }
  const [missingBans, missingMerchantBaselines, missingOfferBaselines] = await Promise.all([
    prisma.$queryRaw<
      Array<{ n: bigint }>
    >`SELECT COUNT(*) n FROM "User" u WHERE u.status IN ('banned','已封禁') AND NOT EXISTS (SELECT 1 FROM "AccountBan" b WHERE b."userId"=u.id)`,
    prisma.merchant.count({ where: { currentApplicationVersion: 0 } }),
    prisma.offer.count({ where: { commercialRevision: 0 } }),
  ])
  return {
    missingBans: Number(missingBans[0].n),
    missingMerchantBaselines,
    missingOfferBaselines,
    asOf: new Date(),
    cutoverAt: cutover[0]?.at ?? null,
    states,
    unknown,
    numbers,
    roles,
    admins,
    unknownRechargeSources: unknownSources[0].n,
    legacyInventoryWithoutItemBatch: legacyInventory,
    walletViolations: violations,
    storage,
  }
}
export async function runGovernanceMigration(o: Options) {
  if (o.resumeAfterId > 0 && !o.entity)
    throw Error('resume_requires_entity: ID checkpoints belong to one table only')
  const before = await governancePreflight()
  const checkpoints: Array<{ entity: string; afterId: number; changed: number }> = []
  const report: Record<string, unknown> = {
    phase: o.phase,
    dryRun: o.dryRun,
    before,
    checkpoints,
    status: 'running',
  }
  const save = async () => {
    if (o.report) await writeFile(o.report, json(report) + '\n')
  }
  const checkpoint = async (entity: Entity, afterId: number, changed: number) => {
    checkpoints.push({ entity, afterId, changed })
    await save()
  }
  const selected = (entity: Entity) => !o.entity || o.entity === entity
  const startAt = (entity: Entity) => (o.entity === entity ? o.resumeAfterId : 0)
  try {
    if (o.phase === 'preflight' || o.dryRun) {
      report.structure = await structureCheck()
      report.status = 'observed'
      await save()
      return report
    }
    if (o.phase === 'backfill' || o.phase === 'finalize') {
      if (!o.maintenance)
        throw Error('maintenance_required: stop all old API/workers before English status cutover')
      if (before.unknown.length || before.roles.length || before.walletViolations.length)
        throw Error(
          'preflight_exceptions: investigate unknown states, identity combinations or wallet differences',
        )
      if (!before.cutoverAt) throw Error('governance_expand_migration_required')
    }
    if (o.phase === 'backfill') {
      for (const [table, field, prefix] of tables) {
        if (!selected(table)) continue
        let cursor = startAt(table)
        for (;;) {
          const rows = await prisma.$queryRawUnsafe<Array<{ id: number; createdAt: Date }>>(
            `SELECT id,"createdAt" FROM "${table}" WHERE id>$1 AND "${field}" IS NULL ORDER BY id LIMIT $2`,
            cursor,
            o.batchSize,
          )
          if (!rows.length) break
          for (let attempt = 0; ; attempt++) {
            try {
              await prisma.$transaction(
                async (tx) => {
                  for (const row of rows)
                    await tx.$executeRawUnsafe(
                      `UPDATE "${table}" SET "${field}"=$1 WHERE id=$2 AND "${field}" IS NULL`,
                      businessNumber(prefix, row.createdAt),
                      row.id,
                    )
                },
                { timeout: 30000 },
              )
              break
            } catch (err) {
              const e = err as { code?: string; meta?: { code?: string; message?: string } }
              if (
                !(
                  e.code === 'P2010' &&
                  e.meta?.code === '23505' &&
                  e.meta.message?.includes(`${table}_${field}_key`)
                ) ||
                attempt >= 7
              )
                throw err
            }
          }
          cursor = rows.at(-1)!.id
          await checkpoint(table, cursor, rows.length)
        }
      }
      if (selected('User')) {
        let cursor = startAt('User')
        for (;;) {
          const rows = await prisma.user.findMany({
            where: { id: { gt: cursor } },
            select: { id: true },
            orderBy: { id: 'asc' },
            take: o.batchSize,
          })
          if (!rows.length) break
          await prisma.$transaction(
            async (tx) => {
              for (const row of rows) {
                await lockUserRefreshSessionMutations(tx, row.id)
                const u = await tx.user.findUniqueOrThrow({
                  where: { id: row.id },
                  select: { status: true, role: true, createdAt: true },
                })
                if (
                  ['已封禁', 'banned'].includes(u.status) &&
                  !(await tx.accountBan.count({ where: { userId: row.id } }))
                )
                  await tx.accountBan.create({
                    data: { userId: row.id, reasonCode: 'legacy_unknown', source: 'legacy' },
                  })
                if (u.status === '正常' || u.status === '已封禁')
                  await tx.user.update({
                    where: { id: row.id },
                    data: { status: u.status === '正常' ? 'active' : 'banned' },
                  })
                if (u.role === 'admin' && u.createdAt <= before.cutoverAt!)
                  await tx.adminAuthorization.upsert({
                    where: { userId: row.id },
                    create: { userId: row.id, tier: 'super' },
                    update: {},
                  })
              }
            },
            { timeout: 30000 },
          )
          cursor = rows.at(-1)!.id
          await checkpoint('User', cursor, rows.length)
        }
      }
      for (const entity of ['OrderStatus', 'Merchant', 'Offer'] as const) {
        if (!selected(entity)) continue
        const table = entity === 'OrderStatus' ? 'Order' : entity
        const condition =
          entity === 'OrderStatus'
            ? "status='completed'"
            : entity === 'Merchant'
              ? '"currentApplicationVersion"=0'
              : '"commercialRevision"=0'
        let cursor = startAt(entity)
        for (;;) {
          const rows = await prisma.$queryRawUnsafe<Array<{ id: number }>>(
            `SELECT id FROM "${table}" WHERE id>$1 AND ${condition} ORDER BY id LIMIT $2`,
            cursor,
            o.batchSize,
          )
          if (!rows.length) break
          const ids = Prisma.join(rows.map((r) => r.id))
          await prisma.$transaction(
            async (tx) => {
              if (entity === 'OrderStatus')
                await tx.$executeRaw`UPDATE "Order" SET status='delivered' WHERE id IN (${ids}) AND status='completed'`
              else if (entity === 'Merchant') {
                await tx.$executeRaw`INSERT INTO "MerchantApplicationRevision" (id,"merchantId",version,name,description,"contactEmail","contactPhone","isLegacyBaseline","submittedAt") SELECT gen_random_uuid(),id,1,name,COALESCE(description,''),COALESCE("contactEmail",''),COALESCE("contactPhone",''),TRUE,(CURRENT_TIMESTAMP AT TIME ZONE 'UTC') FROM "Merchant" WHERE id IN (${ids}) AND "currentApplicationVersion"=0 ON CONFLICT ("merchantId",version) DO NOTHING`
                await tx.$executeRaw`UPDATE "Merchant" SET "currentApplicationVersion"=1 WHERE id IN (${ids}) AND "currentApplicationVersion"=0`
              } else {
                await tx.$executeRaw`INSERT INTO "OfferCommercialRevision" (id,"offerId",revision,"actorType","reasonCode","beforeSafe","afterSafe","changedFields","sourceRef") SELECT gen_random_uuid(),o.id,1,'migration','migration_baseline',NULL,governance_offer_safe(to_jsonb(o)),ARRAY[]::text[],'governance-v1' FROM "Offer" o WHERE o.id IN (${ids}) AND o."commercialRevision"=0 ON CONFLICT ("offerId",revision) DO NOTHING`
                await tx.$executeRaw`UPDATE "Offer" SET "commercialRevision"=1 WHERE id IN (${ids}) AND "commercialRevision"=0`
              }
            },
            { timeout: 30000 },
          )
          cursor = rows.at(-1)!.id
          await checkpoint(entity, cursor, rows.length)
        }
      }
    }
    const after = await governancePreflight()
    report.after = after
    const unresolved = Boolean(
      after.unknown.length ||
      after.roles.length ||
      after.walletViolations.length ||
      after.missingBans ||
      after.missingMerchantBaselines ||
      after.missingOfferBaselines ||
      after.numbers.some((n) => n.missing) ||
      after.states.some(
        (s) =>
          (s.entity === 'user.status' && ['正常', '已封禁'].includes(s.value)) ||
          (s.entity === 'order.status' && s.value === 'completed'),
      ) ||
      after.admins.some((a) => a.createdAt <= after.cutoverAt! && !a.adminAuthorization),
    )
    let structure = await structureCheck()
    if (o.phase === 'finalize') {
      if (unresolved || structure.invalidIndexes.length)
        throw Error('finalize_preconditions_failed: complete all backfills and concurrent indexes')
      const sql = await readFile(
        new URL('../../prisma/post-deploy/governance-v1-finalize.sql', import.meta.url),
        'utf8',
      )
      const { Client } = await import('pg')
      const client = new Client({
        connectionString: process.env.DIRECT_URL ?? process.env.DATABASE_URL,
      })
      await client.connect()
      try {
        await client.query("SET lock_timeout='5s'")
        await client.query("SET statement_timeout='10min'")
        await client.query(sql)
      } finally {
        await client.end()
      }
      structure = await structureCheck()
    }
    report.structure = structure
    report.dataReady = !unresolved
    report.verified =
      !unresolved && !structure.invalidIndexes.length && !structure.missingFinalChecks.length
    if ((o.phase === 'verify' || o.phase === 'finalize') && !report.verified)
      throw Error('verification_failed: remaining data or schema exceptions')
    report.status = 'completed'
    await save()
    return report
  } catch (error) {
    report.status = 'failed'
    report.error = error instanceof Error ? error.message : 'migration_failed'
    report.structure = await structureCheck().catch(() => ({ unavailable: true }))
    await save()
    throw error
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2),
    phase = args.shift() ?? 'preflight'
  const val = (key: string) => {
    const i = args.indexOf(key)
    return i < 0 ? undefined : args[i + 1]
  }
  const o: Options = {
    phase: phase as Options['phase'],
    dryRun: args.includes('--dry-run'),
    batchSize: Number(val('--batch-size') ?? 1000),
    resumeAfterId: Number(val('--resume-after-id') ?? 0),
    entity: val('--entity') as Entity | undefined,
    report: val('--report'),
    maintenance: args.includes('--maintenance'),
  }
  if (
    !['preflight', 'backfill', 'finalize', 'verify'].includes(o.phase) ||
    !Number.isInteger(o.batchSize) ||
    o.batchSize < 1 ||
    o.batchSize > 1000 ||
    !Number.isInteger(o.resumeAfterId) ||
    o.resumeAfterId < 0 ||
    (o.entity && !entities.includes(o.entity))
  )
    throw Error('invalid_cli_arguments')
  runGovernanceMigration(o)
    .then((report) => console.log(json(report)))
    .catch((err) => {
      console.error(err instanceof Error ? err.message : 'governance_migration_failed')
      process.exitCode = 1
    })
    .finally(() => prisma.$disconnect())
}
