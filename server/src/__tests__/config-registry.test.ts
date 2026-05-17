import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { api, authHeader, createTestUser, loginAs } from './helpers.js'
import { prisma } from '../lib/prisma.js'

async function clearSystemConfig() {
  await prisma.$executeRawUnsafe(`
    DO $$
    BEGIN
      IF to_regclass('"SystemConfig"') IS NOT NULL THEN
        DELETE FROM "SystemConfig";
      END IF;
    END $$;
  `)
}

async function loginAdmin(email = 'registry-admin@test.local') {
  const { user, password } = await createTestUser(email, 'admin123', 'admin')
  const { accessToken } = await loginAs(user.email, password)
  return { accessToken }
}

describe('GET /api/config/registry', () => {
  beforeEach(async () => {
    await clearSystemConfig()
  })

  afterEach(async () => {
    await clearSystemConfig()
  })

  it('should return public registry constants and default operational config', async () => {
    const res = await api.get('/api/config/registry').expect(200)

    expect(res.body.productTypes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          value: '网络节点',
          label: '网络节点',
          deliveryModes: expect.arrayContaining(['instant_inventory', 'manual_service']),
        }),
      ])
    )
    expect(res.body.deliveryModes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: 'instant_inventory', label: '即时库存发货' }),
        expect.objectContaining({ value: 'manual_service', label: '人工服务履约' }),
      ])
    )
    expect(res.body.orderStatuses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: 'pending', label: '待处理', tone: 'warning' }),
        expect.objectContaining({ value: 'closed', label: '已关闭', tone: 'neutral' }),
      ])
    )
    expect(res.body.settlementStatuses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: 'pending', label: '待结算', tone: 'warning' }),
        expect.objectContaining({ value: 'settled', label: '已结算', tone: 'success' }),
      ])
    )
    expect(res.body.pagination).toEqual({
      defaultPageSize: 20,
      maxPageSize: 100,
    })
    expect(res.body.inventory).toEqual({
      lowStockThreshold: 5,
    })
  })

  it('should return current operational config values', async () => {
    const { accessToken } = await loginAdmin()

    await api
      .put('/api/admin/config/defaultPageSize')
      .set(authHeader(accessToken))
      .send({ value: 12 })
      .expect(200)
    await api
      .put('/api/admin/config/maxPageSize')
      .set(authHeader(accessToken))
      .send({ value: 60 })
      .expect(200)
    await api
      .put('/api/admin/config/lowStockThreshold')
      .set(authHeader(accessToken))
      .send({ value: 2 })
      .expect(200)

    const res = await api.get('/api/config/registry').expect(200)

    expect(res.body.pagination).toEqual({
      defaultPageSize: 12,
      maxPageSize: 60,
    })
    expect(res.body.inventory).toEqual({
      lowStockThreshold: 2,
    })
  })
})

describe('GET /api/config/registry — M7 member tiers', () => {
  beforeEach(async () => {
    await clearSystemConfig()
  })

  afterEach(async () => {
    await clearSystemConfig()
  })

  it('exposes memberTiers with the 4 expected entries (label + tone)', async () => {
    const res = await api.get('/api/config/registry').expect(200)

    expect(res.body.memberTiers).toHaveLength(4)
    expect(res.body.memberTiers).toEqual([
      { value: 'bronze', label: '普通会员', tone: 'neutral' },
      { value: 'silver', label: '银卡', tone: 'info' },
      { value: 'gold', label: '金卡', tone: 'warning' },
      { value: 'platinum', label: '铂金', tone: 'success' },
    ])
  })

  it('exposes memberTierThresholds with default silver/gold/platinum values', async () => {
    const res = await api.get('/api/config/registry').expect(200)

    expect(res.body.memberTierThresholds).toEqual({
      silver: 1000,
      gold: 5000,
      platinum: 20000,
    })
  })

  it('exposes memberTierBonusBps with bronze:0 plus default silver/gold/platinum values', async () => {
    const res = await api.get('/api/config/registry').expect(200)

    expect(res.body.memberTierBonusBps).toEqual({
      bronze: 0,
      silver: 500,
      gold: 1000,
      platinum: 2000,
    })
  })

  it('reflects updated tier thresholds and bps after admin writes', async () => {
    const { accessToken } = await loginAdmin()

    await api
      .put('/api/admin/config/memberTierSilverThreshold')
      .set(authHeader(accessToken))
      .send({ value: 800 })
      .expect(200)
    await api
      .put('/api/admin/config/memberTierGoldThreshold')
      .set(authHeader(accessToken))
      .send({ value: 4000 })
      .expect(200)
    await api
      .put('/api/admin/config/memberTierPlatinumThreshold')
      .set(authHeader(accessToken))
      .send({ value: 18000 })
      .expect(200)
    await api
      .put('/api/admin/config/memberTierSilverBonusBps')
      .set(authHeader(accessToken))
      .send({ value: 600 })
      .expect(200)

    const res = await api.get('/api/config/registry').expect(200)

    expect(res.body.memberTierThresholds).toEqual({
      silver: 800,
      gold: 4000,
      platinum: 18000,
    })
    expect(res.body.memberTierBonusBps).toEqual({
      bronze: 0,
      silver: 600,
      gold: 1000,
      platinum: 2000,
    })
  })

  it('remains public-read (no auth header required)', async () => {
    const res = await api.get('/api/config/registry').expect(200)
    expect(res.body.memberTiers).toBeDefined()
    expect(res.body.memberTierThresholds).toBeDefined()
    expect(res.body.memberTierBonusBps).toBeDefined()
  })
})
