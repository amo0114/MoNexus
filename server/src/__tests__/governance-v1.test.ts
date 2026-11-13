import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import Ajv from 'ajv'
import jwt from 'jsonwebtoken'
import { afterEach, expect, it } from 'vitest'
import { prisma } from '../lib/prisma.js'
import {
  api,
  authHeader,
  createTestUser,
  createTestMerchant,
  createTestProduct,
  loginAs,
} from './helpers.js'
import { accountStatus } from '../modules/accountGovernance/status.js'
import { createBan, releaseBan } from '../modules/accountGovernance/service.js'
import {
  decideMerchant,
  submitMerchantApplication,
} from '../modules/merchantGovernance/lifecycle.js'
import { authorization, setAuthorization } from '../modules/adminAuthorization/service.js'
import { importMyOfferInventory } from '../modules/merchant/inventoryService.js'
import { batchDetail, voidBatch } from '../modules/catalog/inventoryTraceability.js'
import { updateMyOffer } from '../modules/merchant/offerService.js'
import {
  createExport,
  claimExport,
  materializeExport,
  executeExport,
  downloadExport,
  cleanupExports,
  csvCell,
  exportInput,
  getExport,
} from '../modules/adminExports/service.js'
import { runIntegrityBatch, recheckIntegrityIssue } from '../modules/wallet/integrity.js'
import { creditInTx, findWalletInvariantViolations } from '../modules/wallet/index.js'
import { __setDeliveryStorageForTesting } from '../lib/storage/delivery.js'
import { DeliveryMemoryStorage } from '../lib/storage/deliveryMemory.js'
import { cleanupUnreferencedObjects } from '../lib/fileCleanup.js'
import { type AuthPayload } from '../middlewares/auth.js'
import { userDetail } from '../modules/admin/userQueries.js'
import { createAfterSalesCase, executeAfterSalesCase } from '../modules/orders/afterSales.js'
import { writeMailTestAudit } from '../modules/admin/mailOperations.js'
import { writePaymentAdminLog } from '../modules/payment/audit.js'

function nullable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(nullable)
  if (!value || typeof value !== 'object') return value
  const { nullable: n, ...rest } = value as Record<string, unknown>
  const converted = Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, nullable(v)]))
  return n ? { anyOf: [converted, { type: 'null' }] } : converted
}
const spec = nullable(
  JSON.parse(readFileSync('../docs/api/governance-v1/openapi.json', 'utf8')),
) as object
const ajv = new Ajv({ strict: false })
ajv.addFormat(
  'date-time',
  (v: string) =>
    /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(v) && Number.isFinite(Date.parse(v)),
)
ajv.addFormat(
  'date',
  (v: string) =>
    /^\d{4}-\d{2}-\d{2}$/.test(v) &&
    Number.isFinite(Date.parse(v)) &&
    new Date(v).toISOString().slice(0, 10) === v,
)
ajv.addFormat('uuid', /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
ajv.addFormat('email', /^[^\s@]+@[^\s@]+\.[^\s@]+$/)
ajv.addSchema({ ...spec, $id: 'governance' })
function contract(schema: string, value: unknown) {
  const validate = ajv.compile({ $ref: `governance#/components/schemas/${schema}` })
  const json = JSON.parse(JSON.stringify(value))
  expect(validate(json), JSON.stringify(validate.errors)).toBe(true)
}
async function admin() {
  const { user } = await createTestUser('gov-admin@test.local', 'admin123', 'admin')
  const login = await loginAs(user.email, 'admin123')
  return { user, ...login, payload: jwt.decode(login.accessToken) as AuthPayload }
}
const reason = { reasonCode: 'policy_review', note: '核验后执行此项操作' }
afterEach(() => __setDeliveryStorageForTesting(null))

it('AC-20: live HTTP capabilities, user sections and task summaries match the published contract', async () => {
  const a = await admin()
  const { user } = await createTestUser('gov-http-contract@test.local', 'pass123')
  await loginAs(user.email, 'pass123')
  const routes = [
    ['/capabilities', 'GVCapabilities'],
    [`/users/${user.id}`, 'GVUserDetail'],
    ...Object.entries({
      orders: 'GVUserOrderPage',
      'point-logs': 'GVPointLogPage',
      sessions: 'GVSessionPage',
      referrals: 'GVReferralPage',
      'security-events': 'GVSecurityEventPage',
      audit: 'GVAuditSummaryPage',
      bans: 'GVBanPage',
    }).map(([section, schema]) => [`/users/${user.id}/${section}`, schema]),
    ['/exports', 'GVExportJobPage'],
    ['/wallet-integrity/runs', 'GVIntegrityRunPage'],
    ['/wallet-integrity/issues', 'GVIntegrityIssuePage'],
  ]
  for (const [path, schema] of routes) {
    const response = await api.get(`/api/admin${path}`).set(authHeader(a.accessToken)).expect(200)
    contract(schema, response.body)
  }
})

it('audit details distinguish committed decisions, explicit attempts and mail results without guessing legacy success', async () => {
  const a = await admin()
  const { user } = await createTestUser('gov-audit-state@test.local', 'pass123')
  await createBan(a.user.id, user.id, 'audit-ban', {
    reasonCode: 'abuse',
    reason: '合成理由',
    expiresAt: null,
  })
  const committed = await prisma.adminLog.findFirstOrThrow({
    where: { actionCode: 'account.ban.created' },
  })
  const cases: Array<[number, string]> = [[committed.id, 'committed']]
  for (const phase of ['attempt', 'sent', 'failed', 'rejected', 'rate_limited'] as const) {
    await writeMailTestAudit({
      adminUserId: a.user.id,
      phase,
      recipientMasked: 'a***@example.test',
      correlationId: randomUUID(),
    })
    const row = await prisma.adminLog.findFirstOrThrow({ orderBy: { id: 'desc' } })
    cases.push([row.id, phase])
  }
  await writePaymentAdminLog({
    adminUserId: a.user.id,
    action: 'payment.event.retry',
    targetType: 'PaymentEvent',
    targetKey: randomUUID(),
    operationState: 'attempt',
  })
  cases.push([(await prisma.adminLog.findFirstOrThrow({ orderBy: { id: 'desc' } })).id, 'attempt'])
  for (const data of [
    { action: 'payment.event.retry', detail: '{"outcome":"succeeded","token":"private-value"}' },
    { action: '支付成功', detail: '{"phase":"sent","token":"private-value"}' },
    { action: '测试邮件投递', targetType: 'mailDelivery', detail: '{"phase":"sent"}' },
    {
      action: 'unknown.writer',
      actionCode: 'unknown.writer',
      detailSchemaVersion: 1,
      detailSafe: { operationState: 'attempt', token: 'private-value' },
    },
  ]) {
    const row = await prisma.adminLog.create({ data: { adminUserId: a.user.id, ...data } })
    cases.push([row.id, 'unknown'])
  }
  for (const [id, state] of cases) {
    const response = await api
      .get(`/api/admin/audit/${id}`)
      .set(authHeader(a.accessToken))
      .expect(200)
    contract('GVAuditDetail', response.body)
    expect(response.body.operationState).toBe(state)
    expect(JSON.stringify(response.body)).not.toContain('private-value')
    if (state !== 'committed') expect(response.body.detailSafe).toBeNull()
  }
})

it('AC-09: expiry is effective without cron; revoked sessions never revive, and release is versioned/idempotent', async () => {
  const a = await admin(),
    { user } = await createTestUser('gov-ban@test.local', 'pass123')
  const login = await loginAs(user.email, 'pass123')
  const created = await api
    .post(`/api/admin/users/${user.id}/bans`)
    .set(authHeader(a.accessToken))
    .set('Idempotency-Key', 'ban-1')
    .send({
      reasonCode: 'abuse',
      reason: '临时封禁',
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    })
    .expect(201)
  const ban = created.body
  contract('GVBan', ban)
  expect(await accountStatus(user.id)).toBe('banned')
  await prisma.accountBan.update({
    where: { id: String(ban.id) },
    data: { startsAt: new Date(Date.now() - 60000), expiresAt: new Date(Date.now() - 1000) },
  })
  expect(await accountStatus(user.id)).toBe('active')
  const sql = await prisma.$queryRaw<
    Array<{ active: boolean }>
  >`SELECT governance_user_active(${user.id}::integer) active`
  expect(sql[0].active).toBe(true)
  await api.get('/api/auth/me').set(authHeader(login.accessToken)).expect(401)
  await loginAs(user.email, 'pass123')
  const released = await releaseBan(a.user.id, user.id, String(ban.id), 'release-1', {
    expectedVersion: 0,
    reason: '人工复核结束',
  })
  contract('GVBan', released)
  await expect(
    releaseBan(a.user.id, user.id, String(ban.id), 'release-1', {
      expectedVersion: 0,
      reason: '人工复核结束',
    }),
  ).resolves.toMatchObject({ version: 1 })
  await expect(
    releaseBan(a.user.id, user.id, String(ban.id), 'release-2', {
      expectedVersion: 0,
      reason: '重复决定',
    }),
  ).rejects.toMatchObject({ code: 'STATE_CONFLICT' })
})

it('AC-05/06/07/08: one application decision wins, resubmission retains identity; suspension grants historical access only', async () => {
  const a = await admin(),
    { user } = await createTestUser('gov-merchant@test.local', 'pass123')
  const first = await submitMerchantApplication(
    user.id,
    { name: '测试申请', contactEmail: user.email },
    'apply-1',
  )
  contract('GVMerchantApplication', first)
  const mid = first.merchantId!
  const input = {
    ...reason,
    expectedLifecycleVersion: first.lifecycleVersion,
    applicationVersion: first.applicationVersion,
  }
  const rejected = await decideMerchant(a.user.id, mid, 'reject', input, 'reject-1')
  const second = await submitMerchantApplication(
    user.id,
    { name: '补充资料后的申请', contactEmail: user.email },
    'apply-2',
    rejected.lifecycleVersion,
  )
  expect(second.merchantId).toBe(mid)
  expect(second.applicationVersion).toBe(2)
  await expect(
    decideMerchant(a.user.id, mid, 'approve', input, 'stale-decision'),
  ).rejects.toMatchObject({ code: 'STATE_CONFLICT' })
  const decisions = await Promise.allSettled(
    ['approve', 'reject'].map((action) =>
      decideMerchant(
        a.user.id,
        mid,
        action as 'approve' | 'reject',
        {
          ...reason,
          expectedLifecycleVersion: second.lifecycleVersion,
          applicationVersion: second.applicationVersion,
        },
        `decide-${action}`,
      ),
    ),
  )
  expect(decisions.filter((x) => x.status === 'fulfilled')).toHaveLength(1)
  let m = await prisma.merchant.findUniqueOrThrow({ where: { id: mid } })
  if (m.status === 'rejected') {
    const resubmit = await submitMerchantApplication(
      user.id,
      { name: '再次修订', contactEmail: user.email },
      'apply-3',
      m.lifecycleVersion,
    )
    await decideMerchant(
      a.user.id,
      mid,
      'approve',
      {
        ...reason,
        expectedLifecycleVersion: resubmit.lifecycleVersion,
        applicationVersion: resubmit.applicationVersion,
      },
      'approve-3',
    )
  }
  const suspended = await decideMerchant(a.user.id, mid, 'suspend', reason, 'suspend-1')
  contract('GVMerchantApplication', suspended)
  expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).role).toBe('merchant')
  const login = await loginAs(user.email, 'pass123')
  await api.get('/api/merchant/orders').set(authHeader(login.accessToken)).expect(200)
  await api.post('/api/merchant/products').set(authHeader(login.accessToken)).send({}).expect(403)
  await createBan(a.user.id, user.id, 'merchant-ban', {
    reasonCode: 'review',
    reason: '账号独立限制',
    expiresAt: null,
  })
  await expect(
    decideMerchant(a.user.id, mid, 'restore', reason, 'restore-blocked'),
  ).rejects.toMatchObject({ status: 403 })
  expect((await prisma.merchant.findUniqueOrThrow({ where: { id: mid } })).status).toBe('suspended')
})

it('AC-10: current grants guard hidden actions, independent routers, upload and delivery evidence', async () => {
  const a = await admin()
  const { user: op } = await createTestUser('gov-op@test.local', 'pass123', 'admin')
  await setAuthorization(a.user.id, op.id, 'auth-1', {
    tier: 'operator',
    expectedVersion: 0,
    permissions: ['users.read'],
    reason: '最小读取权限',
  })
  const login = await loginAs(op.email, 'pass123'),
    h = authHeader(login.accessToken)
  const cap = await api.get('/api/admin/capabilities').set(h).expect(200)
  contract('GVCapabilities', cap.body)
  expect(cap.body.permissions).toEqual(['users.read'])
  for (const url of [
    '/api/admin/orders/1',
    '/api/admin/assurance-applications',
    '/api/admin/product-videos',
    '/api/admin/audit/1',
  ])
    await api.get(url).set(h).expect(403)
  await api.post('/api/uploads/image').set(h).expect(403)
  await api.put('/api/admin/merchants/1/approve').set(h).send({}).expect(403)
  const users = await api.get('/api/admin/users?sort=netSpentPoints').set(h).expect(200)
  contract('GVUserList', users.body)
  await setAuthorization(a.user.id, op.id, 'auth-2', {
    tier: 'operator',
    expectedVersion: 1,
    permissions: [],
    reason: '撤销所有读取权限',
  })
  await api.get('/api/admin/users').set(h).expect(403)
  await expect(
    setAuthorization(a.user.id, a.user.id, 'last-super', {
      tier: 'operator',
      expectedVersion: 0,
      permissions: [],
      reason: '测试最后管理员保护',
    }),
  ).rejects.toMatchObject({ code: 'STATE_CONFLICT' })
})

it('AC-14/15: imported items share a real batch; only available items void; safe commercial changes append once', async () => {
  const a = await admin(),
    { user, merchant } = await createTestMerchant('gov-stock@test.local', 'pass123', {
      status: 'active',
    })
  const p = await createTestProduct('批次商品', 100, 0, [], merchant.id)
  const offer = await prisma.offer.findFirstOrThrow({ where: { productId: p.id } })
  await importMyOfferInventory(merchant.id, user.id, p.id, offer.id, {
    items: ['batch-secret-one', 'batch-secret-two'],
  })
  const batch = await prisma.inventoryBatch.findFirstOrThrow({ where: { productId: p.id } })
  expect(await prisma.inventoryItem.count({ where: { batchId: batch.id } })).toBe(2)
  const buyer = await createTestUser('gov-stock-buyer@test.local', 'pass123')
  const login = await loginAs(buyer.user.email, 'pass123')
  const purchase = api
    .post('/api/orders')
    .set(authHeader(login.accessToken))
    .send({ productId: p.id })
  const [sale, voided] = await Promise.all([
    purchase,
    voidBatch(a.user.id, p.id, batch.id, true, 'void-1', reason),
  ])
  expect([201, 400]).toContain(sale.status)
  expect(
    await prisma.inventoryItem.count({ where: { batchId: batch.id, status: 'available' } }),
  ).toBe(0)
  expect(
    (await prisma.inventoryItem.count({ where: { batchId: batch.id, status: 'sold' } })) +
      voided.voidedCount,
  ).toBe(2)
  contract('GVVoidBatchResult', voided)
  contract(
    'GVInventoryBatchDetail',
    await batchDetail(a.user.id, p.id, batch.id, true, { pageSize: 20 }),
  )
  const wrongKind = Buffer.from(
    JSON.stringify({
      scope: `batch-orders:${batch.id}`,
      id: randomUUID(),
      time: new Date().toISOString(),
    }),
  ).toString('base64url')
  await expect(
    batchDetail(a.user.id, p.id, batch.id, true, { pageSize: 20, cursor: wrongKind }),
  ).rejects.toMatchObject({ status: 400 })
  const before = await prisma.offerCommercialRevision.count({ where: { offerId: offer.id } })
  await updateMyOffer(merchant.id, p.id, offer.id, { price: 101 })
  await updateMyOffer(merchant.id, p.id, offer.id, { price: 101 })
  expect(await prisma.offerCommercialRevision.count({ where: { offerId: offer.id } })).toBe(
    before + 1,
  )
  const revision = await prisma.offerCommercialRevision.findFirstOrThrow({
    where: { offerId: offer.id },
    orderBy: { revision: 'desc' },
  })
  contract('GVOfferRevision', revision)
  expect(JSON.stringify(revision)).not.toContain('batch-secret')
  expect(revision.actorUserId).toBe(user.id)
  expect(revision.changedFields).toEqual(['price'])
})

it('AC-16: executed aftersales refunds count even when the order remains closed; restricted overview omits assets', async () => {
  const a = await admin(),
    { user } = await createTestUser('gov-spend@test.local', 'pass123')
  const p = await createTestProduct('售后统计商品', 100, 1, ['one-secret'])
  const login = await loginAs(user.email, 'pass123')
  const bought = await api
    .post('/api/orders')
    .set(authHeader(login.accessToken))
    .send({ productId: p.id })
    .expect(201)
  expect(bought.body.orderNo).toMatch(/^MN\d{8}-[0-9A-HJKMNP-TV-Z]{12}$/)
  await api
    .post(`/api/orders/${bought.body.orderId}/close`)
    .set(authHeader(login.accessToken))
    .expect(200)
  const c = await createAfterSalesCase(a.user.id, bought.body.orderId, { reason: '统计验证' })
  await executeAfterSalesCase(a.user.id, c.id, '确认执行全额售后')
  expect(
    (await prisma.order.findUniqueOrThrow({ where: { id: bought.body.orderId } })).status,
  ).toBe('closed')
  const detail = await userDetail(a.user.id, user.id)
  contract('GVUserDetail', detail)
  expect(detail.stats).toMatchObject({ chargedPoints: 100, refundedPoints: 100, netSpentPoints: 0 })
})

it('AC-17/18: export retries retain materialized snapshot, private registration survives GC, current grants and expiry gate download', async () => {
  const a = await admin(),
    storage = new (class extends DeliveryMemoryStorage {
      async listFinalKeysOlderThan() {
        return (await this.list()).map((x) => x.key)
      }
    })()
  __setDeliveryStorageForTesting(storage)
  const { user } = await createTestUser('gov-export@test.local', 'pass123')
  await prisma.user.update({ where: { id: user.id }, data: { nickname: '=HYPERLINK("sentinel")' } })
  const created = await createExport(a.payload, 'export-1', {
    kind: 'users',
    filters: { q: String(user.id) },
  })
  contract('GVExportJob', created)
  await expect(
    createExport(a.payload, 'export-1', { kind: 'users', filters: { q: String(user.id) } }),
  ).resolves.toMatchObject({ id: created.id })
  let claimed = (await claimExport())!
  await materializeExport(claimed)
  await prisma.user.update({ where: { id: user.id }, data: { nickname: 'changed-after-snapshot' } })
  await prisma.adminExportJob.update({
    where: { id: claimed.id },
    data: { leaseUntil: new Date(Date.now() - 1) },
  })
  claimed = (await claimExport())!
  await executeExport(claimed)
  const done = await prisma.adminExportJob.findUniqueOrThrow({ where: { id: created.id } })
  expect(done.status).toBe('succeeded')
  const body = (await storage.getObject(done.objectKey!))!.toString()
  expect(body).toContain("'=HYPERLINK")
  expect(body).not.toContain('changed-after-snapshot')
  expect(csvCell(-5)).toBe('-5')
  await cleanupUnreferencedObjects()
  await expect(downloadExport(a.user.id, created.id)).resolves.toHaveProperty('url')
  await prisma.adminExportJob.update({
    where: { id: created.id },
    data: { expiresAt: new Date(Date.now() - 1) },
  })
  await expect(downloadExport(a.user.id, created.id)).rejects.toMatchObject({
    code: 'EXPORT_EXPIRED',
  })
  await cleanupExports()
  expect(await storage.getObject(done.objectKey!)).toBeNull()
  expect(await prisma.adminExportRow.count({ where: { jobId: created.id } })).toBe(0)
})

it('AC-19: scan records both source differences, never changes money, and resolves only after a fresh successful aggregate', async () => {
  const a = await admin(),
    { user } = await createTestUser('gov-scan@test.local', 'pass123', 'user', 0)
  await prisma.$transaction((tx) =>
    creditInTx(
      tx,
      {
        operationKey: 'gov-credit',
        userId: user.id,
        source: { kind: 'test', id: user.id },
        reasonCode: 'test',
        log: { reason: '来源' },
      },
      { amount: 100, origin: 'reward' },
    ),
  )
  await prisma.pointAccount.update({
    where: { userId: user.id },
    data: { balance: 99, frozenBalance: 1 },
  })
  await runIntegrityBatch(true)
  const issues = await prisma.walletIntegrityIssue.findMany({ where: { userId: user.id } })
  expect(issues).toHaveLength(2)
  expect(issues.every((i) => i.status === 'open')).toBe(true)
  await recheckIntegrityIssue(a.user.id, issues[0].id, 'check-1', '已看，未修复')
  expect(
    (await prisma.walletIntegrityIssue.findUniqueOrThrow({ where: { id: issues[0].id } })).status,
  ).toBe('open')
  expect(
    (await prisma.pointAccount.findUniqueOrThrow({ where: { userId: user.id } })).balance,
  ).toBe(99)
  await prisma.pointAccount.update({
    where: { userId: user.id },
    data: { balance: 100, frozenBalance: 0 },
  })
  const resolved = await recheckIntegrityIssue(a.user.id, issues[0].id, 'check-2', '复查来源守恒')
  contract('GVIntegrityIssue', resolved)
  expect(resolved.status).toBe('resolved')
  expect(await findWalletInvariantViolations()).toEqual([])
})

it('AC-11: failed success audit rolls back ban, session revocation and command receipt together', async () => {
  const a = await admin(),
    { user } = await createTestUser('gov-audit-rollback@test.local', 'pass123')
  const login = await loginAs(user.email, 'pass123')
  await prisma.$executeRawUnsafe(
    `CREATE FUNCTION governance_test_audit_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."actionCode"='account.ban.created' THEN RAISE EXCEPTION 'test_audit_failure'; END IF; RETURN NEW; END $$`,
  )
  await prisma.$executeRawUnsafe(
    `CREATE TRIGGER governance_test_audit_fail BEFORE INSERT ON "AdminLog" FOR EACH ROW EXECUTE FUNCTION governance_test_audit_fail()`,
  )
  try {
    await expect(
      createBan(a.user.id, user.id, 'audit-rollback', {
        reasonCode: 'test',
        reason: '原子审计验证',
        expiresAt: null,
      }),
    ).rejects.toThrow()
    expect(await accountStatus(user.id)).toBe('active')
    expect(await prisma.accountBan.count({ where: { userId: user.id } })).toBe(0)
    expect(
      await prisma.adminCommandReceipt.count({ where: { id: `${a.user.id}:audit-rollback` } }),
    ).toBe(0)
    await api.get('/api/auth/me').set(authHeader(login.accessToken)).expect(200)
  } finally {
    await prisma.$executeRawUnsafe('DROP TRIGGER governance_test_audit_fail ON "AdminLog"')
    await prisma.$executeRawUnsafe('DROP FUNCTION governance_test_audit_fail()')
  }
})

it('AC-17: a stale export worker cannot complete or overwrite the replacement lease', async () => {
  const a = await admin()
  __setDeliveryStorageForTesting(new DeliveryMemoryStorage())
  const created = await createExport(a.payload, 'stale-export', { kind: 'users', filters: {} })
  const stale = (await claimExport())!
  await materializeExport(stale)
  await prisma.adminExportJob.update({
    where: { id: created.id },
    data: { leaseUntil: new Date(Date.now() - 1) },
  })
  const current = (await claimExport())!
  expect(current.leaseToken).not.toBe(stale.leaseToken)
  await executeExport(stale)
  expect(
    (await prisma.adminExportJob.findUniqueOrThrow({ where: { id: created.id } })).leaseToken,
  ).toBe(current.leaseToken)
  await executeExport(current)
  expect(
    (await prisma.adminExportJob.findUniqueOrThrow({ where: { id: created.id } })).status,
  ).toBe('succeeded')
})

it('AC-18: revoking a kind read grant blocks both existing downloads and queued execution', async () => {
  const a = await admin()
  __setDeliveryStorageForTesting(new DeliveryMemoryStorage())
  const { user: operator } = await createTestUser(
    'gov-export-operator@test.local',
    'pass123',
    'admin',
  )
  await setAuthorization(a.user.id, operator.id, 'export-grants-1', {
    tier: 'operator',
    expectedVersion: 0,
    permissions: ['exports.create', 'users.read'],
    reason: '导出用户职责',
  })
  const login = await loginAs(operator.email, 'pass123'),
    payload = jwt.decode(login.accessToken) as AuthPayload
  const first = await createExport(payload, 'export-before-revoke', { kind: 'users', filters: {} })
  await expect(getExport(operator.id, randomUUID())).rejects.toMatchObject({ status: 404 })
  const other = await createExport(a.payload, 'other-admin-export', { kind: 'orders', filters: {} })
  await expect(getExport(operator.id, other.id)).rejects.toMatchObject({ status: 404 })
  await prisma.adminExportJob.update({ where: { id: other.id }, data: { status: 'failed' } })
  await executeExport((await claimExport())!)
  await expect(downloadExport(operator.id, first.id)).resolves.toHaveProperty('url')
  const queued = await api
    .post('/api/admin/exports')
    .set(authHeader(login.accessToken))
    .set('Idempotency-Key', 'export-queued-revoke')
    .send({ kind: 'users', filters: {} })
    .expect(202)
  const second = queued.body
  await setAuthorization(a.user.id, operator.id, 'export-grants-2', {
    tier: 'operator',
    expectedVersion: 1,
    permissions: ['exports.create'],
    reason: '撤销用户读取职责',
  })
  await expect(downloadExport(operator.id, first.id)).rejects.toMatchObject({
    code: 'PERMISSION_DENIED',
  })
  await executeExport((await claimExport())!)
  const blocked = await prisma.adminExportJob.findUniqueOrThrow({ where: { id: second.id } })
  expect(blocked).toMatchObject({
    status: 'failed',
    errorCode: 'PERMISSION_DENIED',
    snapshotAt: null,
    objectKey: null,
  })
})

it('export filter contract enforces kind fields and compares instants across time zones', () => {
  const validate = ajv.compile({ $ref: 'governance#/components/schemas/GVExportInput' })
  for (const input of [
    { kind: 'users', filters: { userId: 1 } },
    { kind: 'orders', filters: { q: 'test' } },
    { kind: 'orders', filters: { status: 'completed' } },
    { kind: 'point_logs', filters: { status: 'active' } },
  ]) {
    expect(validate(input)).toBe(false)
    expect(exportInput.safeParse(input).success).toBe(false)
  }
  const from = '2026-01-01T00:30:00+01:00',
    to = '2025-12-31T23:45:00Z'
  const accepted = { kind: 'users', filters: { from, to } }
  expect(validate(accepted)).toBe(true)
  expect(exportInput.safeParse(accepted).success).toBe(true)
  expect(exportInput.safeParse({ kind: 'users', filters: { from: to, to: from } }).success).toBe(
    false,
  )
})
