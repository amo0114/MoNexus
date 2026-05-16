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
