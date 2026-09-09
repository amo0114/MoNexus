import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./client', () => ({
  default: { get: vi.fn(), post: vi.fn() },
}))

import client from './client'
import { createOrder } from './orders'

const mockPost = client.post as unknown as ReturnType<typeof vi.fn>

const ORDER_RESULT = {
  orderId: 11,
  productName: '条款商品',
  price: 100,
  status: 'delivered',
  deliveryMode: 'instant_inventory',
  balanceAfter: 900,
  merchantId: null,
  merchantName: null,
}

beforeEach(() => {
  mockPost.mockReset()
  mockPost.mockResolvedValue({ data: ORDER_RESULT })
})

describe('createOrder checkout term fields', () => {
  it('POSTs expectedProductContentVersion and expectedAssuranceGrantId: null from the confirmed preview', async () => {
    await createOrder(42, {
      expectedPrice: 100,
      idempotencyKey: '11111111-1111-4111-8111-111111111111',
      offerId: 7,
      expectedPurchaseFormVersion: 'pf-v1',
      expectedCheckoutVersion: 'co-v1',
      expectedProductContentVersion: 3,
      expectedAssuranceGrantId: null,
    })

    expect(mockPost).toHaveBeenCalledTimes(1)
    const [path, body, config] = mockPost.mock.calls[0]
    expect(path).toBe('/orders')
    expect(body).toEqual({
      productId: 42,
      offerId: 7,
      expectedPrice: 100,
      expectedPurchaseFormVersion: 'pf-v1',
      expectedCheckoutVersion: 'co-v1',
      expectedProductContentVersion: 3,
      expectedAssuranceGrantId: null,
    })
    expect(Object.prototype.hasOwnProperty.call(body, 'expectedAssuranceGrantId')).toBe(true)
    expect(JSON.parse(JSON.stringify(body)).expectedAssuranceGrantId).toBeNull()
    expect(config).toEqual({
      headers: { 'Idempotency-Key': '11111111-1111-4111-8111-111111111111' },
    })
  })

  it('POSTs a numeric expectedAssuranceGrantId together with the content version', async () => {
    await createOrder(42, {
      expectedPrice: 100,
      idempotencyKey: '22222222-2222-4222-8222-222222222222',
      expectedProductContentVersion: 1,
      expectedAssuranceGrantId: 9,
    })

    const body = mockPost.mock.calls[0][1]
    expect(body).toMatchObject({
      productId: 42,
      expectedProductContentVersion: 1,
      expectedAssuranceGrantId: 9,
    })
  })
})
