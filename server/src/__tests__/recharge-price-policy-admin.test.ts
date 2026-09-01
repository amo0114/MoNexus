import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '../lib/prisma.js'
import { api, authHeader, createTestUser, loginAs } from './helpers.js'
import { RP_CNY_VMQFOX_V1_CREATE_EXAMPLE } from '../modules/recharge/adminSchema.js'

async function loginAdmin(email: string) {
  await createTestUser(email, 'pass12345', 'admin')
  return loginAs(email, 'pass12345')
}

async function loginUser(email: string) {
  await createTestUser(email, 'pass12345')
  return loginAs(email, 'pass12345')
}

beforeEach(async () => {
  await prisma.adminLog.deleteMany()
  await prisma.rechargeSuggestedAmount.deleteMany()
  await prisma.rechargePricePolicy.deleteMany()
})

afterEach(async () => {
  await prisma.adminLog.deleteMany()
})

describe('admin recharge price policies', () => {
  it('creates a draft, lists it, and never auto-activates the VMQFox example', async () => {
    const { accessToken } = await loginAdmin('price-policy-create@test.local')
    const created = await api.post('/api/admin/recharge/price-policies')
      .set(authHeader(accessToken))
      .send(RP_CNY_VMQFOX_V1_CREATE_EXAMPLE)
      .expect(201)

    expect(created.body).toMatchObject({
      code: 'rp-cny-vmqfox-v1',
      currency: 'CNY',
      adminSandbox: false,
      status: 'draft',
      pointsNumerator: '1',
      pointsDenominator: '1',
      roundingMode: 'HALF_EVEN',
      minAmountMinor: '100',
      maxAmountMinor: '100000',
      amountStepMinor: '100',
      dailyLimitMinor: '200000',
      monthlyLimitMinor: '1000000',
      limitTimeZone: 'Asia/Shanghai',
    })
    expect(created.body.suggestedAmounts).toEqual([
      { amountMinor: '1000', sortOrder: 1 },
      { amountMinor: '3000', sortOrder: 2 },
      { amountMinor: '5000', sortOrder: 3 },
      { amountMinor: '10000', sortOrder: 4 },
    ])
    expect(created.body.status).not.toBe('active')

    const listed = await api.get('/api/admin/recharge/price-policies')
      .query({ adminSandbox: 'false' })
      .set(authHeader(accessToken))
      .expect(200)
    expect(listed.body.total).toBe(1)
    expect(listed.body.items[0]).toMatchObject({
      id: created.body.id,
      code: 'rp-cny-vmqfox-v1',
      status: 'draft',
      adminSandbox: false,
    })

    const stored = await prisma.rechargePricePolicy.findUniqueOrThrow({ where: { id: created.body.id } })
    expect(stored.status).toBe('draft')

    const logs = await prisma.adminLog.findMany({ where: { action: 'recharge.price_policy.create' } })
    expect(logs).toHaveLength(1)
    expect(logs[0]!.detail).toContain('rp-cny-vmqfox-v1')
    expect(logs[0]!.detail).toContain('draft')
  })

  it('rejects status on create so a production policy cannot be auto-activated', async () => {
    const { accessToken } = await loginAdmin('price-policy-status@test.local')
    const res = await api.post('/api/admin/recharge/price-policies')
      .set(authHeader(accessToken))
      .send({ ...RP_CNY_VMQFOX_V1_CREATE_EXAMPLE, status: 'active' })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('FIELD_NOT_WRITABLE')
    expect(await prisma.rechargePricePolicy.count()).toBe(0)
  })

  it('activates a draft, retires the previous active policy on the same lane, and writes AdminLog', async () => {
    const { accessToken } = await loginAdmin('price-policy-activate@test.local')
    const first = await api.post('/api/admin/recharge/price-policies')
      .set(authHeader(accessToken))
      .send({ ...RP_CNY_VMQFOX_V1_CREATE_EXAMPLE, code: 'rp-cny-lane-v1' })
      .expect(201)
    const second = await api.post('/api/admin/recharge/price-policies')
      .set(authHeader(accessToken))
      .send({ ...RP_CNY_VMQFOX_V1_CREATE_EXAMPLE, code: 'rp-cny-lane-v2' })
      .expect(201)

    const activated = await api.post(`/api/admin/recharge/price-policies/${first.body.id}/activate`)
      .set(authHeader(accessToken))
      .expect(200)
    expect(activated.body.status).toBe('active')

    const replaced = await api.post(`/api/admin/recharge/price-policies/${second.body.id}/activate`)
      .set(authHeader(accessToken))
      .expect(200)
    expect(replaced.body.status).toBe('active')

    const rows = await prisma.rechargePricePolicy.findMany({ orderBy: { code: 'asc' } })
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'rp-cny-lane-v1', status: 'retired' }),
      expect.objectContaining({ code: 'rp-cny-lane-v2', status: 'active' }),
    ]))
    expect(rows.filter(item => item.status === 'active')).toHaveLength(1)

    const logs = await prisma.adminLog.findMany({
      where: { action: 'recharge.price_policy.activate' },
      orderBy: { id: 'asc' },
    })
    expect(logs).toHaveLength(2)
    expect(logs[1]!.detail).toContain(second.body.id)
    expect(logs[1]!.targetType).toBe('RechargePricePolicy')
  })

  it('does not retire an active sandbox policy when activating a production policy', async () => {
    const { accessToken } = await loginAdmin('price-policy-lane@test.local')
    const sandbox = await prisma.rechargePricePolicy.create({
      data: {
        code: 'admin-sandbox-cny-v1',
        version: 1,
        currency: 'CNY',
        adminSandbox: true,
        currencyScale: 2,
        pointsNumerator: 1n,
        pointsDenominator: 1n,
        minAmountMinor: 100n,
        maxAmountMinor: 100_000n,
        amountStepMinor: 100n,
        dailyLimitMinor: 200_000n,
        monthlyLimitMinor: 1_000_000n,
        limitTimeZone: 'Asia/Shanghai',
        status: 'active',
        effectiveAt: new Date(),
      },
    })
    const draft = await api.post('/api/admin/recharge/price-policies')
      .set(authHeader(accessToken))
      .send(RP_CNY_VMQFOX_V1_CREATE_EXAMPLE)
      .expect(201)
    await api.post(`/api/admin/recharge/price-policies/${draft.body.id}/activate`)
      .set(authHeader(accessToken))
      .expect(200)

    const sandboxRow = await prisma.rechargePricePolicy.findUniqueOrThrow({ where: { id: sandbox.id } })
    expect(sandboxRow.status).toBe('active')
    const production = await prisma.rechargePricePolicy.findUniqueOrThrow({ where: { id: draft.body.id } })
    expect(production.status).toBe('active')
    expect(production.adminSandbox).toBe(false)
  })

  it('rejects duplicate codes and forbids ordinary users', async () => {
    const { accessToken } = await loginAdmin('price-policy-dup@test.local')
    await api.post('/api/admin/recharge/price-policies')
      .set(authHeader(accessToken))
      .send(RP_CNY_VMQFOX_V1_CREATE_EXAMPLE)
      .expect(201)
    const dup = await api.post('/api/admin/recharge/price-policies')
      .set(authHeader(accessToken))
      .send(RP_CNY_VMQFOX_V1_CREATE_EXAMPLE)
    expect(dup.status).toBe(409)

    const user = await loginUser('price-policy-user@test.local')
    await api.get('/api/admin/recharge/price-policies').set(authHeader(user.accessToken)).expect(403)
    await api.post('/api/admin/recharge/price-policies')
      .set(authHeader(user.accessToken))
      .send(RP_CNY_VMQFOX_V1_CREATE_EXAMPLE)
      .expect(403)
  })
})
