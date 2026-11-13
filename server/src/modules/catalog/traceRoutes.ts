import type { Router, Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import { batchDetail, listBatches, listOfferRevisions, voidBatch } from './inventoryTraceability.js'
import { cursorQuery, parseRequestKey, reasonInput } from '../governance/common.js'
const id = z.coerce.number().int().positive().max(2147483647)
const uuid = z.string().uuid()
const key = (r: Request) => parseRequestKey(r.header('Idempotency-Key'))
const handler =
  (f: (r: Request) => Promise<unknown>) => (r: Request, s: Response, n: NextFunction) => {
    f(r)
      .then((value) => s.json(value))
      .catch(n)
  }
export function mountTraceRoutes(router: Router, admin: boolean) {
  router.get(
    '/products/:id/inventory/batches',
    handler((r) =>
      listBatches(r.user!.userId, id.parse(r.params.id), admin, cursorQuery.parse(r.query)),
    ),
  )
  router.get(
    '/products/:id/inventory/batches/:batchId',
    handler((r) =>
      batchDetail(
        r.user!.userId,
        id.parse(r.params.id),
        uuid.parse(r.params.batchId),
        admin,
        cursorQuery.parse(r.query),
      ),
    ),
  )
  router.post(
    '/products/:id/inventory/batches/:batchId/void',
    handler((r) =>
      voidBatch(
        r.user!.userId,
        id.parse(r.params.id),
        uuid.parse(r.params.batchId),
        admin,
        key(r),
        reasonInput.parse(r.body),
      ),
    ),
  )
  router.get(
    '/products/:id/offers/:offerId/revisions',
    handler((r) =>
      listOfferRevisions(
        r.user!.userId,
        id.parse(r.params.id),
        id.parse(r.params.offerId),
        admin,
        cursorQuery.parse(r.query),
      ),
    ),
  )
}
