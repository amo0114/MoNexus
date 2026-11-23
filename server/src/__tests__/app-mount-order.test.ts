import { describe, it, expect } from 'vitest'
import { app } from '../app.js'
import { errorHandler } from '../middlewares/errorHandler.js'
import { productRoutes } from '../modules/products/routes.js'
import { shareLinkRoutes } from '../modules/products/shareLinkRoutes.js'
import { pointRoutes } from '../modules/points/routes.js'
import { chatBindRoutes } from '../modules/chatbot/bindRoutes.js'
import { orderReviewRoutes, productReviewRoutes } from '../modules/reviews/routes.js'
import { orderRoutes } from '../modules/orders/routes.js'
import { uploadsRoutes } from '../modules/uploads/routes.js'
import { deliveryFileRoutes } from '../modules/uploads/deliveryFileRoutes.js'
import { publicSponsoredRouter } from '../modules/merchandising/promotions/publicRoutes.js'
import { publicEditorialRouter } from '../modules/merchandising/editorial/routes.js'
import { paymentWebhookRoutes } from '../modules/payment/webhooks/routes.js'
import { xboardBotRoutes } from '../modules/chatbot/xboard/routes.js'

// AG-06: app.ts mount order is load-bearing (AGENTS.md §3); comments alone do not guard it.
type Layer = { name: string; handle: unknown }
const stack = (app as unknown as { _router: { stack: Layer[] } })._router.stack

function indexOf(handle: unknown, label: string) {
  const index = stack.findIndex(layer => layer.handle === handle)
  expect(index, `${label} is mounted`).toBeGreaterThanOrEqual(0)
  return index
}

describe('app mount order', () => {
  it('mounts raw-body webhooks before the JSON parser', () => {
    const json = stack.findIndex(layer => layer.name === 'jsonParser')
    expect(json).toBeGreaterThanOrEqual(0)
    expect(indexOf(paymentWebhookRoutes, 'payment webhooks')).toBeLessThan(json)
    expect(indexOf(xboardBotRoutes, 'xboard bot v2')).toBeLessThan(json)
  })

  it('mounts fixed product sub-paths before the greedy /:id router', () => {
    const products = indexOf(productRoutes, 'productRoutes')
    for (const [router, label] of [
      [publicSponsoredRouter, 'sponsored'],
      [publicEditorialRouter, 'editorial'],
      [shareLinkRoutes, 'share links'],
      [productReviewRoutes, 'product reviews'],
    ] as const) {
      expect(indexOf(router, label), label).toBeLessThan(products)
    }
  })

  it('mounts shared-prefix routers before their owners', () => {
    expect(indexOf(deliveryFileRoutes, 'delivery files')).toBeLessThan(indexOf(uploadsRoutes, 'uploads'))
    expect(indexOf(chatBindRoutes, 'chat binding')).toBeLessThan(indexOf(pointRoutes, 'points'))
    expect(indexOf(orderReviewRoutes, 'order reviews')).toBeLessThan(indexOf(orderRoutes, 'orders'))
  })

  it('keeps the error handler last', () => {
    expect(stack[stack.length - 1]?.handle).toBe(errorHandler)
  })
})
