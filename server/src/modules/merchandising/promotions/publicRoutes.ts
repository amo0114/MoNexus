// T-MERCH-BE-004 — Public sponsored router (SPEC-MERCH-001 §7.5).
//
// Public, no auth. The CMI Integration Owner mounts this router at
// `/api/products` so the full path becomes `GET /api/products/sponsored`
// (products service/StorePage are CMI-owned and untouched by this lane).
// 缓存≤60s、10min bucket 轮换与 disclosure 均由 service 提供。

import { Router } from 'express'
import { validate } from '../../../middlewares/validate.js'
import * as controller from './publicController.js'
import { sponsoredQuerySchema } from './schema.js'

export const publicSponsoredRouter = Router()

publicSponsoredRouter.get('/sponsored', validate({ query: sponsoredQuerySchema }), controller.listSponsored)
