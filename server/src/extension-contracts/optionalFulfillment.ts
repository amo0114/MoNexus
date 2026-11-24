import type { Prisma } from '@prisma/client'
import type { RequestHandler } from 'express'
import type { FulfillmentProvider } from './fulfillment.js'

export interface OptionalFulfillmentPlugin {
  contractVersion: 1
  provider: FulfillmentProvider
  runtimeContext: RequestHandler
  buyerRoutes: RequestHandler
  rawBotRoutes: RequestHandler
  adminRoutes: RequestHandler
  assertReady(): Promise<void>
  assertDetachable(tx: Prisma.TransactionClient): Promise<void>
}
