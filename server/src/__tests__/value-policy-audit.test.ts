import { afterEach, describe, expect, it } from 'vitest'
import { config } from '../config/index.js'
import { prisma } from '../lib/prisma.js'
import { auditValuePolicies } from '../modules/valuePolicy/audit.js'
import { createTestCnyValuePolicy, createTestProduct, createTestUser } from './helpers.js'

const originalMode = config.pointValuePolicyMode

afterEach(() => {
  config.pointValuePolicyMode = originalMode
})

describe('value-policy audit command', () => {
  it('reports a clean system when there is no policy and mode is off', async () => {
    config.pointValuePolicyMode = 'off'
    const report = await auditValuePolicies(prisma)
    expect(report.ok).toBe(true)
    expect(report.summary.activePolicyCount).toBe(0)
    expect(report.findings).toEqual([])
  })

  it('accepts a legal active CNY policy and a consistent snapshot', async () => {
    config.pointValuePolicyMode = 'shadow'
    const policy = await createTestCnyValuePolicy({ id: 'vp_audit_ok', version: 15001 })
    const { user } = await createTestUser('vp-audit-ok@test.local', 'pass123', 'user', 500)
    const product = await createTestProduct('审计商品', 100, 1, ['a-1'])
    const order = await prisma.order.create({
      data: { userId: user.id, productId: product.id, price: 100 },
    })
    await prisma.orderPricingSnapshot.create({
      data: {
        orderId: order.id,
        pointsAssetCode: 'RP',
        pointsAmountAtomic: 100n,
        valuePolicyId: policy.id,
        referenceAssetCode: 'CNY',
        referenceAmountAtomic: 100n,
        roundingMode: 'HALF_EVEN',
      },
    })

    const report = await auditValuePolicies(prisma)
    expect(report.ok).toBe(true)
    expect(report.summary.activePolicyCount).toBe(1)
    expect(report.findings).toEqual([])
  })

  it('flags enabled-mode orders that lack a snapshot only inside --since', async () => {
    config.pointValuePolicyMode = 'enforce'
    await createTestCnyValuePolicy({ id: 'vp_audit_missing', version: 15002 })
    const { user } = await createTestUser('vp-audit-missing@test.local', 'pass123', 'user', 500)
    const product = await createTestProduct('缺快照商品', 80, 1, ['m-1'])
    const order = await prisma.order.create({
      data: { userId: user.id, productId: product.id, price: 80 },
    })

    const skipped = await auditValuePolicies(prisma)
    expect(skipped.summary.missingSnapshotCheck).toBe('skipped_no_since')
    expect(skipped.findings.some(item => item.code === 'enabled_mode_order_missing_snapshot')).toBe(false)

    const report = await auditValuePolicies(prisma, {
      since: new Date(order.createdAt.getTime() - 1000),
    })
    expect(report.ok).toBe(false)
    expect(report.summary.missingSnapshotCheck).toBe('ran')
    expect(report.findings.some(item => item.code === 'enabled_mode_order_missing_snapshot')).toBe(true)
  })

  it('does not treat off-era orders as missing snapshots after switching to shadow', async () => {
    config.pointValuePolicyMode = 'off'
    const { user } = await createTestUser('vp-audit-off@test.local', 'pass123', 'user', 500)
    const product = await createTestProduct('off期订单', 90, 1, ['o-1'])
    const offOrder = await prisma.order.create({
      data: { userId: user.id, productId: product.id, price: 90 },
    })

    config.pointValuePolicyMode = 'shadow'
    await createTestCnyValuePolicy({ id: 'vp_audit_rollout', version: 15004 })
    const rollout = new Date(offOrder.createdAt.getTime() + 1000)
    const report = await auditValuePolicies(prisma, { since: rollout })
    expect(report.ok).toBe(true)
    expect(report.summary.missingSnapshotCheck).toBe('ran')
    expect(report.findings).toEqual([])
  })

  it('does not use an older retired policy activation as the missing-snapshot window', async () => {
    config.pointValuePolicyMode = 'off'
    const { user } = await createTestUser('vp-audit-retired@test.local', 'pass123', 'user', 500)
    const product = await createTestProduct('旧政策窗口', 70, 1, ['r-1'])
    const oldOrder = await prisma.order.create({
      data: { userId: user.id, productId: product.id, price: 70 },
    })

    await createTestCnyValuePolicy({ id: 'vp_audit_old', version: 15005, status: 'retired' })
    await createTestCnyValuePolicy({ id: 'vp_audit_new', version: 15006 })
    config.pointValuePolicyMode = 'shadow'
    const since = new Date(oldOrder.createdAt.getTime() + 1000)
    const report = await auditValuePolicies(prisma, { since })
    expect(report.ok).toBe(true)
    expect(report.findings).toEqual([])
  })

  it('does not mutate rows', async () => {
    config.pointValuePolicyMode = 'off'
    await createTestCnyValuePolicy({ id: 'vp_audit_readonly', version: 15003 })
    const before = await prisma.valuePolicy.findMany()
    await auditValuePolicies(prisma)
    const after = await prisma.valuePolicy.findMany()
    expect(after).toEqual(before)
    expect(await prisma.assetDefinition.count()).toBeGreaterThanOrEqual(2)
  })
})
