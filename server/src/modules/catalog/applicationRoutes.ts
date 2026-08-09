// T-CAT-BE-002 — Merchant category-application sub-router
// (SPEC-CATALOG-OPS-001 §7.3; REQ-CAT-F-008; CHK-CAT-006~007).
//
// Mounted from `server/src/modules/merchant/routes.ts` AFTER its
// authenticate → requireActiveUser → requireMerchant chain, so every route
// here already has an ACTIVE merchant caller (REQ-CAT-NF-004). The merchantId
// is resolved server-side from auth — it can never be taken from the body.
//
// Endpoints (spec §7.3):
//   GET  /            list own applications (optional status filter)
//   POST /            create a pending application
//   POST /:id/withdraw  withdraw a pending application (D-CAT-10)

import { Router } from 'express'
import { validate, idParamSchema } from '../../middlewares/validate.js'
import {
  createCategoryApplicationSchema,
  listMyCategoryApplicationsQuerySchema,
} from './applicationSchema.js'
import * as controller from './applicationController.js'

const router = Router()

router.get('/', validate({ query: listMyCategoryApplicationsQuerySchema }), controller.merchantList)
router.post('/', validate(createCategoryApplicationSchema), controller.merchantCreate)
router.post('/:id/withdraw', validate({ params: idParamSchema }), controller.merchantWithdraw)

export { router as categoryApplicationRoutes }
