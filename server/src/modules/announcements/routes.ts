import { Router } from 'express'
import { authenticate, authenticateIfPresent, requireActiveUser } from '../../middlewares/auth.js'
import { idParamSchema, validate } from '../../middlewares/validate.js'
import { announcementReceiptBodySchema, listPublicAnnouncementsQuerySchema } from './schema.js'
import * as controller from './controller.js'

const router = Router()

// 公告公开查询：未认证可读，仅返回当前生效的 published 公告。
router.get('/', validate({ query: listPublicAnnouncementsQuerySchema }), authenticateIfPresent, controller.listPublic)
router.post('/:id/read', authenticate, requireActiveUser, validate({
  params: idParamSchema,
  body: announcementReceiptBodySchema,
}), controller.markRead)
router.post('/:id/acknowledge', authenticate, requireActiveUser, validate({
  params: idParamSchema,
  body: announcementReceiptBodySchema,
}), controller.acknowledge)

export { router as announcementRoutes }
