/** Disposable, synthetic PostgreSQL scale evidence. Build server first.
 * Requires NODE_ENV=test and a database named *_governance_rehearsal.
 * No production keys, users, delivery content or provider calls are needed. */
import pg from 'pg'
import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { cpus, totalmem } from 'node:os'
import { writeFile } from 'node:fs/promises'

const database = new URL(process.env.DATABASE_URL ?? '')
if (process.env.NODE_ENV !== 'test' || !database.pathname.endsWith('_governance_rehearsal'))
  throw Error('disposable_governance_database_required')
const client = new pg.Client({ connectionString: database.toString() })
await client.connect()
const evidence = {
  asOf: new Date().toISOString(),
  environment: {
    node: process.version,
    cpu: cpus()[0]?.model,
    logicalCpus: cpus().length,
    memoryBytes: totalmem(),
  },
  timings: {},
  plans: {},
}
try {
  evidence.environment.postgresql = (await client.query('SELECT version() version')).rows[0].version
  const base = (
    await client.query(
      `SELECT p.id product_id,o.id offer_id,u.id admin_id FROM "Product" p JOIN "Offer" o ON o."productId"=p.id CROSS JOIN "User" u WHERE u.role='admin' ORDER BY p.id,u.id LIMIT 1`,
    )
  ).rows[0]
  if (!base) throw Error('run_representative_migration_rehearsal_first')
  await client.query(
    `INSERT INTO "User" (email,password,status,"createdAt") SELECT 'gov-scale-'||g||'@example.test','unusable-synthetic-hash','active',timestamp '2026-01-01'+g*interval '10 minutes' FROM generate_series(1,10000) g ON CONFLICT(email) DO NOTHING`,
  )
  const existing = Number(
    (
      await client.query(
        `SELECT COUNT(*) n FROM "Order" WHERE "productNameSnapshot"='GOV_SCALE_V1'`,
      )
    ).rows[0].n,
  )
  if (!existing) {
    for (let bucket = 0; bucket < 100; bucket++) {
      await client.query(
        `INSERT INTO "Order" ("userId","productId","offerId",price,status,"productNameSnapshot","createdAt") SELECT u.id,$1,$2,100,'closed','GOV_SCALE_V1',timestamp '2026-06-01'+n*interval '1 day'+u.id*interval '1 second' FROM "User" u CROSS JOIN generate_series(1,10) n WHERE u.email LIKE 'gov-scale-%@example.test' AND mod(u.id,100)=$3`,
        [base.product_id, base.offer_id, bucket],
      )
    }
    await client.query(
      `INSERT INTO "PointAccount" ("userId",balance,"walletInitializedAt") SELECT id,2000,(CURRENT_TIMESTAMP AT TIME ZONE 'UTC') FROM "User" WHERE email LIKE 'gov-scale-%@example.test' ON CONFLICT("userId") DO NOTHING`,
    )
    await client.query(
      `INSERT INTO "WalletOperation" ("operationKey",kind,"userId",amount,"requestHash","sourceKind","sourceId","reasonCode","balanceAfter","frozenAfter") SELECT 'gov-scale-credit:'||u.id||':'||n,'credit',u.id,1000,repeat('a',64),'test',u.id||':'||n,'scale_fixture',n*1000,0 FROM "User" u CROSS JOIN generate_series(1,3) n WHERE u.email LIKE 'gov-scale-%@example.test'`,
    )
    await client.query(
      `INSERT INTO "PointLot" ("userId","originKind","sourceOperationId","issuedPoints","availablePoints","consumedPoints") SELECT "userId",CASE WHEN "operationKey" LIKE '%:3' THEN 'recharge' ELSE 'reward' END,id,1000,CASE WHEN "operationKey" LIKE '%:3' THEN 1000 ELSE 500 END,CASE WHEN "operationKey" LIKE '%:3' THEN 0 ELSE 500 END FROM "WalletOperation" WHERE "operationKey" LIKE 'gov-scale-credit:%'`,
    )
    await client.query(
      `INSERT INTO "PointLog" ("userId",type,amount,"balanceAfter","orderId",reason,"createdAt") SELECT "userId",'out',100,3000-(row_number() OVER (PARTITION BY "userId" ORDER BY id))::int*100,id,'synthetic scale charge',"createdAt" FROM "Order" WHERE "productNameSnapshot"='GOV_SCALE_V1'`,
    )
    await client.query(
      `INSERT INTO "WalletOperation" ("operationKey",kind,"userId",amount,"requestHash","sourceKind","sourceId","reasonCode","balanceAfter","frozenAfter","pointLogId","createdAt") SELECT 'gov-scale-spend:'||l."orderId",'spend',l."userId",100,repeat('b',64),'order',l."orderId"::text,'scale_fixture',l."balanceAfter",0,l.id,l."createdAt" FROM "PointLog" l JOIN "Order" o ON o.id=l."orderId" WHERE o."productNameSnapshot"='GOV_SCALE_V1'`,
    )
    await client.query(
      `INSERT INTO "WalletAllocation" ("operationId","lotId","availableDelta","frozenDelta","consumedDelta") SELECT w.id,l.id,-100,0,100 FROM "WalletOperation" w JOIN "WalletOperation" c ON c."operationKey"='gov-scale-credit:'||w."userId"||':'||CASE WHEN w."balanceAfter">=2500 THEN '1' ELSE '2' END JOIN "PointLot" l ON l."sourceOperationId"=c.id WHERE w."operationKey" LIKE 'gov-scale-spend:%'`,
    )
  }
  await client.query('ANALYZE')
  const { prisma } = await import('../dist/lib/prisma.js')
  const { listGovernanceUsers, userDetail, userSection } =
    await import('../dist/modules/admin/userQueries.js')
  const { runIntegrityBatch } = await import('../dist/modules/wallet/integrity.js')
  const { findWalletInvariantViolations } = await import('../dist/modules/wallet/queries.js')
  const { createExport, claimExport, materializeExport } =
    await import('../dist/modules/adminExports/service.js')
  const sample = (
    await client.query(`SELECT id FROM "User" WHERE email='gov-scale-5000@example.test'`)
  ).rows[0].id
  const measure = async (name, fn, count = 20) => {
    const times = []
    for (let i = 0; i < count; i++) {
      const t = performance.now()
      await fn()
      times.push(performance.now() - t)
    }
    const sorted = times.slice().sort((a, b) => a - b)
    evidence.timings[name] = {
      samples: count,
      firstMs: times[0],
      p50Ms: sorted[Math.ceil(count * 0.5) - 1],
      p95Ms: sorted[Math.ceil(count * 0.95) - 1],
      maxMs: sorted.at(-1),
    }
  }
  try {
    await measure('users_createdAt', () =>
      listGovernanceUsers(base.admin_id, { page: 1, pageSize: 20 }),
    )
    await measure('users_netSpentPoints', () =>
      listGovernanceUsers(base.admin_id, { page: 1, pageSize: 20, sort: 'netSpentPoints' }),
    )
    await measure('users_exact_uid', () =>
      listGovernanceUsers(base.admin_id, { q: String(sample), pageSize: 20 }),
    )
    await measure('users_fuzzy', () =>
      listGovernanceUsers(base.admin_id, { q: 'gov-scale-50', pageSize: 20 }),
    )
    await measure('user_detail', () => userDetail(base.admin_id, sample))
    const first = await userSection(base.admin_id, sample, 'orders', { pageSize: 5 })
    await measure('user_orders_keyset', () =>
      userSection(base.admin_id, sample, 'orders', {
        pageSize: 5,
        cursor: first.pageInfo.nextCursor ?? undefined,
      }),
    )
    await measure('user_point_logs_keyset', () =>
      userSection(base.admin_id, sample, 'point-logs', { pageSize: 5 }),
    )
    await client.query('UPDATE "User" SET "mfaEnabled"=true WHERE id=$1', [base.admin_id])
    const session = (
      await client.query(
        `INSERT INTO "RefreshToken" ("userId","tokenHash","expiresAt") VALUES ($1,$2,(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')+interval '1 hour') RETURNING "sessionId"`,
        [base.admin_id, `synthetic-scale-${randomUUID()}`],
      )
    ).rows[0]
    const payload = {
      userId: base.admin_id,
      role: 'admin',
      sid: session.sessionId,
      mfaVerified: true,
      mfaVersion: 0,
    }
    await measure('export_enqueue', async () => {
      const created = await createExport(payload, `scale-enqueue:${randomUUID()}`, {
        kind: 'users',
        filters: {},
      })
      await client.query(
        `UPDATE "AdminExportJob" SET status='failed',"expiresAt"=(CURRENT_TIMESTAMP AT TIME ZONE 'UTC') WHERE id=$1`,
        [created.id],
      )
    })
    const oversized = await createExport(payload, `scale-limit:${randomUUID()}`, {
      kind: 'orders',
      filters: {},
    })
    const claimed = await claimExport()
    if (claimed?.id !== oversized.id) throw Error('unexpected_pending_fixture_export')
    try {
      await materializeExport(claimed)
      throw Error('row_limit_not_enforced')
    } catch (error) {
      if (error.code !== 'EXPORT_LIMIT_EXCEEDED') throw error
    }
    if (await prisma.adminExportRow.count({ where: { jobId: oversized.id } }))
      throw Error('oversized_snapshot_not_rolled_back')
    evidence.exportLimit = {
      rows: 100000,
      attemptedRows: 100001,
      errorCode: 'EXPORT_LIMIT_EXCEEDED',
      materializedRows: 0,
    }
    await client.query(
      `UPDATE "AdminExportJob" SET status='failed',"leaseUntil"=NULL,"leaseToken"=NULL,"expiresAt"=(CURRENT_TIMESTAMP AT TIME ZONE 'UTC') WHERE id=$1`,
      [oversized.id],
    )
    if ((await findWalletInvariantViolations()).length)
      throw Error('scale_fixture_wallet_difference')
    let run = await runIntegrityBatch(true)
    const initial = run
    while (run?.status === 'running') run = await runIntegrityBatch()
    if (!run || run.id !== initial.id || run.scannedCount !== 10000)
      throw Error('scan_checkpoint_coverage_failed')
    evidence.integrity = {
      id: run.id,
      firstBatchCount: initial.scannedCount,
      scannedCount: run.scannedCount,
      status: run.status,
    }
    const queries = {
      orders_keyset: [
        'SELECT id,"createdAt" FROM "Order" WHERE "userId"=$1 ORDER BY "createdAt" DESC,id DESC LIMIT 21',
        [sample],
      ],
      point_logs_keyset: [
        'SELECT id,"createdAt" FROM "PointLog" WHERE "userId"=$1 ORDER BY "createdAt" DESC,id DESC LIMIT 21',
        [sample],
      ],
      exact_order_no: [
        'SELECT id FROM "Order" WHERE "orderNo"=$1',
        [
          (await client.query(`SELECT "orderNo" FROM "Order" ORDER BY id DESC LIMIT 1`)).rows[0]
            .orderNo,
        ],
      ],
    }
    for (const [name, [sql, values]] of Object.entries(queries))
      evidence.plans[name] = (
        await client.query('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ' + sql, values)
      ).rows[0]['QUERY PLAN']
    evidence.counts = (
      await client.query(
        `SELECT (SELECT COUNT(*) FROM "User") users,(SELECT COUNT(*) FROM "Order") orders,(SELECT COUNT(*) FROM "PointLog") point_logs,(SELECT COUNT(*) FROM "PointLot") lots`,
      )
    ).rows[0]
    const exceeded = Object.entries(evidence.timings)
      .filter(([name, v]) => v.p95Ms > (name.includes('keyset') ? 300 : 500))
      .map(([name]) => name)
    evidence.budget = { listDetailMs: 500, keysetMs: 300, exceeded }
    if (exceeded.length) process.exitCode = 1
  } finally {
    await prisma.$disconnect()
  }
} finally {
  await client.end()
  const report = process.argv[2] ?? '/tmp/governance-scale-evidence.json'
  await writeFile(report, JSON.stringify(evidence, null, 2) + '\n')
  console.log(
    JSON.stringify(
      {
        report,
        timings: evidence.timings,
        budget: evidence.budget,
        counts: evidence.counts,
        integrity: evidence.integrity,
      },
      null,
      2,
    ),
  )
}
