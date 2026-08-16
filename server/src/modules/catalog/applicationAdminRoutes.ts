// T-CAT-BE-002 — Admin category-application review sub-router
// (SPEC-CATALOG-OPS-001 §7.3; D-CAT-10/D-CAT-11; REQ-CAT-F-008;
// CHK-CAT-008~009; AC-CAT-013~014).
//
// Mounted from `server/src/modules/admin/routes.ts` AFTER its
// authenticate → requireActiveUser → requireAdmin → requireAdminMfa chain, so
// every route here inherits the full admin/MFA boundary (REQ-CAT-NF-004).
//
// Endpoints (spec §7.3):
//   GET  /            list all applications (status / merchantId / pagination)
//   POST /:id/approve approve via create_new or map_existing (CAS + AdminLog)
//   POST /:id/reject  reject with a review reason (CAS + AdminLog)

import { Router } from 'express'
import { validate, idParamSchema } from '../../middlewares/validate.js'
import {
  approveCategoryApplicationSchema,
  listAdminCategoryApplicationsQuerySchema,
  rejectCategoryApplicationSchema,
} from './applicationSchema.js'
import * as controller from './applicationController.js'

const router = Router()

router.get('/', validate({ query: listAdminCategoryApplicationsQuerySchema }), controller.adminList)
router.post('/:id/approve', validate({ params: idParamSchema, body: approveCategoryApplicationSchema }), controller.adminApprove)
router.post('/:id/reject', validate({ params: idParamSchema, body: rejectCategoryApplicationSchema }), controller.adminReject)

export { router as categoryApplicationAdminRoutes }
