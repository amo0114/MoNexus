import { describe, it } from 'vitest'
import { api, createTestUser, createTestProduct, loginAs, authHeader } from './helpers.js'
import { expectOpenApiResponse } from './openapiContract.js'

// Products list/detail, checkout preview and /auth/me currently drift from the
// document; they join this test once the Owner settles which side is correct
// (docs/specs/architecture-guardrails.plan.md §2.5).
describe('OpenAPI response contract (orders)', () => {
  it('matches the documented order creation and detail responses', async () => {
    await createTestUser('contract@test.local', 'pass123', 'user', 1000)
    const product = await createTestProduct('契约商品', 100, 2, ['c-1', 'c-2'])
    const { accessToken } = await loginAs('contract@test.local', 'pass123')
    const auth = authHeader(accessToken)

    const order = await api.post('/api/orders').set(auth).send({ productId: product.id, expectedPrice: 100 }).expect(201)
    expectOpenApiResponse(order, 'POST', '/api/orders')
    expectOpenApiResponse(await api.get(`/api/orders/${order.body.orderId}`).set(auth).expect(200), 'GET', '/api/orders/{id}')
  })
})
