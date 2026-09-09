import { describe, expect, it } from 'vitest'
import { prisma } from '../../lib/prisma.js'
import { createTestUser } from '../../__tests__/helpers.js'
import { getActiveNetworkNodeCategoryId } from '../../__tests__/catalogFixture.js'
import { serializeAdminOrderDetail } from '../orders/serializers.js'
import { getOrderDetail } from './service.js'
import { EXTERNAL_CATALOG_PROVIDER } from '../catalog/constants.js'

const SECRET_SKU = 'SECRET-SKU-MUST-NOT-LEAK'
const SECRET_LEASE = 'SECRET-LEASE-MUST-NOT-LEAK'
const SECRET_SOURCE_HASH = 'aa'.repeat(32)
const SECRET_REQUEST_HASH = 'bb'.repeat(32)
const SECRET_SNAPSHOT = 'SECRET-SNAPSHOT-MUST-NOT-LEAK'

let serial = 0
function uniq(prefix: string): string {
  serial += 1
  return `${prefix}-${Date.now()}-${serial}`
}

async function seedPlatformFakaOrder(input: { withTask: boolean; withLink: boolean }) {
  const admin = await createTestUser(uniq('od-faka-admin') + '@test.local', 'pass123', 'admin')
  const buyer = await createTestUser(uniq('od-faka-buyer') + '@test.local', 'pass123', 'user')
  const product = await prisma.product.create({
    data: {
      name: 'Xboard 平台开通',
      type: '网络节点',
      categoryId: await getActiveNetworkNodeCategoryId(),
      price: 100,
      status: 'active',
      deliveryMode: 'manual_service',
      stockMode: 'unlimited',
      merchantId: null,
    },
  })
  const offer = await prisma.offer.create({
    data: {
      productId: product.id,
      name: '月卡',
      isDefault: true,
      price: 100,
      deliveryMode: 'manual_service',
      stockMode: 'unlimited',
      stock: 0,
      externalIntegration: 'faka_bridge',
      externalSku: SECRET_SKU,
    },
  })
  if (input.withLink) {
    await prisma.externalCatalogLink.create({
      data: {
        provider: EXTERNAL_CATALOG_PROVIDER.FAKA_BRIDGE,
        externalProductId: String(90_000 + serial),
        productId: product.id,
        sourceHash: SECRET_SOURCE_HASH,
        sourceSnapshot: { leak: SECRET_SNAPSHOT },
        idempotencyKey: uniq('faka-link'),
        requestHash: SECRET_REQUEST_HASH,
        importedByUserId: admin.user.id,
      },
    })
  }
  const order = await prisma.order.create({
    data: {
      userId: buyer.user.id,
      productId: product.id,
      offerId: offer.id,
      price: 100,
      status: 'pending',
      merchantId: null,
      deliveryModeSnapshot: 'manual_service',
      productNameSnapshot: product.name,
      holdingPoints: 100,
      fundsHeld: true,
    },
  })
  let taskId: number | null = null
  if (input.withTask) {
    const task = await prisma.fakaBridgeTask.create({
      data: {
        orderId: order.id,
        requestOrderNo: `MN-${order.id}`,
        emailSnapshot: buyer.user.email,
        skuSnapshot: SECRET_SKU,
        periodSnapshot: 'monthly',
        leaseToken: SECRET_LEASE,
      },
    })
    taskId = task.id
  }
  return { orderId: order.id, taskId, productId: product.id }
}

function assertNoFakaSecrets(payload: unknown) {
  const json = JSON.stringify(payload)
  expect(json).not.toContain(SECRET_SKU)
  expect(json).not.toContain(SECRET_LEASE)
  expect(json).not.toContain(SECRET_SOURCE_HASH)
  expect(json).not.toContain(SECRET_REQUEST_HASH)
  expect(json).not.toContain(SECRET_SNAPSHOT)
  expect(json).not.toContain('externalCatalogLink')
  expect(json).not.toContain('skuSnapshot')
  expect(json).not.toContain('leaseToken')
  expect(json).not.toContain('sourceHash')
}

describe('admin getOrderDetail Faka/Xboard projection', () => {
  it('exposes fakaBridgeTask.id and product.fakaBridge without leaking secrets', async () => {
    const { orderId, taskId, productId } = await seedPlatformFakaOrder({
      withTask: true,
      withLink: true,
    })

    const detail = await getOrderDetail(orderId)

    expect(detail.fakaBridgeTask).toEqual({ id: taskId })
    expect(detail.product).toMatchObject({
      id: productId,
      name: 'Xboard 平台开通',
      fakaBridge: true,
    })
    expect(detail.product).not.toHaveProperty('externalCatalogLink')
    expect(detail.fakaBridgeTask).not.toHaveProperty('skuSnapshot')
    expect(detail.fakaBridgeTask).not.toHaveProperty('leaseToken')
    assertNoFakaSecrets(detail)
  })

  it('sets product.fakaBridge when a catalog link exists even without a task', async () => {
    const { orderId, productId } = await seedPlatformFakaOrder({
      withTask: false,
      withLink: true,
    })

    const detail = await getOrderDetail(orderId)

    expect(detail.fakaBridgeTask).toBeNull()
    expect(detail.product).toMatchObject({ id: productId, fakaBridge: true })
    expect(detail.product).not.toHaveProperty('externalCatalogLink')
    assertNoFakaSecrets(detail)
  })

  it('strips extra faka fields from serializeAdminOrderDetail input', () => {
    const serialized = serializeAdminOrderDetail({
      id: 11,
      status: 'pending',
      createdAt: new Date('2026-04-01T00:00:00.000Z'),
      deliveryModeSnapshot: 'manual_service',
      fakaBridgeTask: {
        id: 9,
        skuSnapshot: SECRET_SKU,
        leaseToken: SECRET_LEASE,
        emailSnapshot: 'buyer@test.local',
      },
      product: {
        id: 7,
        name: 'Xboard 月卡',
        externalCatalogLink: {
          id: 3,
          sourceHash: SECRET_SOURCE_HASH,
          requestHash: SECRET_REQUEST_HASH,
          sourceSnapshot: { leak: SECRET_SNAPSHOT },
        },
      },
    })

    expect(serialized).toMatchObject({
      fakaBridgeTask: { id: 9 },
      product: { id: 7, name: 'Xboard 月卡', fakaBridge: true },
    })
    expect(serialized.product).not.toHaveProperty('externalCatalogLink')
    assertNoFakaSecrets(serialized)
  })
})
