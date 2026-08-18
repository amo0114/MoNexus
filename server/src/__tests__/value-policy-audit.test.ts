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

  it('flags enabled-mode orders that lack a snapshot', async () => {
    config.pointValuePolicyMode = 'enforce'
    await createTestCnyValuePolicy({ id: 'vp_audit_missing', version: 15002 })
    const { user } = await createTestUser('vp-audit-missing@test.local', 'pass123', 'user', 500)
    const product = await createTestProduct('缺快照商品', 80, 1, ['m-1'])
    await prisma.order.create({
      data: { userId: user.id, productId: product.id, price: 80 },
    })

    const report = await auditValuePolicies(prisma)
    expect(report.ok).toBe(false)
    expect(report.findings.some(item => item.code === 'enabled_mode_order_missing_snapshot')).toBe(true)
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
