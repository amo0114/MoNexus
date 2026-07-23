import { Router } from 'express'
import { authenticateIfPresent } from '../../middlewares/auth.js'
import { validate } from '../../middlewares/validate.js'
import { listPublicAnnouncementsQuerySchema } from './schema.js'
import * as controller from './controller.js'

const router = Router()

// 公告公开查询：未认证可读，仅返回当前生效的 published 公告。
router.get('/', validate({ query: listPublicAnnouncementsQuerySchema }), authenticateIfPresent, controller.listPublic)

export { router as announcementRoutes }
