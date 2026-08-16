// T-CAT-BE-001 — Admin product-categories sub-router (SPEC-CATALOG-OPS-001
// §7.2; REQ-CAT-F-007; D-CAT-06/D-CAT-07; AC-CAT-010~011).
//
// Mounted from `server/src/modules/admin/routes.ts` AFTER its
// authenticate → requireActiveUser → requireAdmin → requireAdminMfa chain, so
// every route here inherits the full admin/MFA boundary (REQ-CAT-NF-004).
//
// Endpoints (spec §7.2 + D-CAT-07 physical-delete refusal):
//   GET    /               list (status/page/pageSize)
//   POST   /               create
//   PATCH  /:id            update (code immutable — rejected pre-validation)
//   POST   /:id/activate   status CAS
//   POST   /:id/deactivate status CAS
//   POST   /reorder        transactional sortOrder rewrite
//   DELETE /:id            logical delete/tombstone → inactive (refused while referenced)

import { Router, type RequestHandler } from 'express'
import { validate, idParamSchema } from '../../middlewares/validate.js'
import { CATALOG_ERROR_CODES } from './constants.js'
import { categoryHttpError } from './categoryService.js'
import {
  createCategorySchema,
  updateCategorySchema,
  listCategoriesQuerySchema,
  reorderCategoriesSchema,
} from './categorySchema.js'
import * as controller from './categoryController.js'

const router = Router()

/**
 * D-CAT-06: `code` is immutable after creation. The update schema is strict
 * and rejects unknown keys, but we surface the semantic error before generic
 * validation so clients get the stable CATEGORY_CODE_IMMUTABLE code.
 */
const rejectCodePatch: RequestHandler = (req, _res, next) => {
  const body = req.body as Record<string, unknown> | undefined
  if (body && typeof body === 'object' && 'code' in body) {
    next(categoryHttpError(400, CATALOG_ERROR_CODES.CATEGORY_CODE_IMMUTABLE, '分类编码创建后不可修改'))
    return
  }
  next()
}

router.get('/', validate({ query: listCategoriesQuerySchema }), controller.list)
router.post('/', validate(createCategorySchema), controller.create)
router.patch('/:id', rejectCodePatch, validate({ params: idParamSchema, body: updateCategorySchema }), controller.update)
router.post('/:id/activate', validate({ params: idParamSchema }), controller.activate)
router.post('/:id/deactivate', validate({ params: idParamSchema }), controller.deactivate)
router.post('/reorder', validate(reorderCategoriesSchema), controller.reorder)
router.delete('/:id', validate({ params: idParamSchema }), controller.remove)

export { router as categoryAdminRoutes }
