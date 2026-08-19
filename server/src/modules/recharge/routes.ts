import { Router } from 'express'
import { config } from '../../config/index.js'
import { authenticate, requireActiveUser, requireVerifiedEmail } from '../../middlewares/auth.js'
import { validate } from '../../middlewares/validate.js'
import { createSimulatorControlRouter } from '../payment/providers/simulator/control.js'
import { shouldRegisterSimulatorControlRoutes } from '../payment/providers/simulator/index.js'
import * as controller from './controller.js'
import {
  createOrderSchema,
  createQuoteSchema,
  listOrdersQuerySchema,
  rechargeConfigQuerySchema,
  uuidParamSchema,
} from './schema.js'

export function createRechargeRouter(options: { isProductionDeploy: boolean }) {
  const router = Router()
  router.use(authenticate, requireActiveUser)

  router.get('/config', validate({ query: rechargeConfigQuerySchema }), controller.config)
  router.post('/quotes', requireVerifiedEmail, validate(createQuoteSchema), controller.createQuote)
  router.post('/orders', requireVerifiedEmail, validate(createOrderSchema), controller.createOrder)
  router.get('/orders', validate({ query: listOrdersQuerySchema }), controller.listOrders)
  router.post('/orders/:id/complete', requireVerifiedEmail, validate({ params: uuidParamSchema }), controller.completeOrder)
  router.post('/orders/:id/cancel', requireVerifiedEmail, validate({ params: uuidParamSchema }), controller.cancelOrder)
  router.post('/orders/:id/refunds', requireVerifiedEmail, validate({ params: uuidParamSchema }), controller.requestRefund)
  router.get('/orders/:id', validate({ params: uuidParamSchema }), controller.getOrder)

  if (shouldRegisterSimulatorControlRoutes(options.isProductionDeploy)) {
    router.use('/simulator', createSimulatorControlRouter())
  }

  return router
}

export const rechargeRoutes = createRechargeRouter({
  isProductionDeploy: config.isProductionDeploy,
})
