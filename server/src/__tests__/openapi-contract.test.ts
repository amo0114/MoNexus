import { describe, it } from 'vitest'
import { api, createTestUser, createTestProduct, loginAs, authHeader } from './helpers.js'
import { expectOpenApiResponse } from './openapiContract.js'

describe('OpenAPI response contract (core buyer journey)', () => {
  it('matches the documented responses for products, checkout, orders and the current user', async () => {
    await createTestUser('contract@test.local', 'pass123', 'user', 1000)
    const product = await createTestProduct('契约商品', 100, 2, ['c-1', 'c-2'])
    const { accessToken } = await loginAs('contract@test.local', 'pass123')
    const auth = authHeader(accessToken)

    expectOpenApiResponse(await api.get('/api/products').expect(200), 'GET', '/api/products')
    expectOpenApiResponse(await api.get(`/api/products/${product.id}`).expect(200), 'GET', '/api/products/{id}')
    expectOpenApiResponse(
      await api.get('/api/checkout/preview').query({ productId: product.id }).set(auth).expect(200),
      'GET', '/api/checkout/preview',
    )
    const order = await api.post('/api/orders').set(auth).send({ productId: product.id, expectedPrice: 100 }).expect(201)
    expectOpenApiResponse(order, 'POST', '/api/orders')
    expectOpenApiResponse(await api.get(`/api/orders/${order.body.orderId}`).set(auth).expect(200), 'GET', '/api/orders/{id}')
    expectOpenApiResponse(await api.get('/api/auth/me').set(auth).expect(200), 'GET', '/api/auth/me')
  })
})
