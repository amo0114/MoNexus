import { Router } from 'express'
import { authenticate, requireActiveUser, requireVerifiedEmail } from '../../middlewares/auth.js'
import * as controller from './controller.js'
import * as botController from '../chatbot/bindController.js'

const router = Router()

router.use(authenticate, requireActiveUser)
router.post('/checkin', requireVerifiedEmail, controller.checkin)
router.get('/history', controller.history)
router.get('/checkin/status', controller.checkinStatus)
router.get('/tier', controller.tier)

// SPEC-CHAT-BOT-001：绑定主路径在 QQ 群内完成（发 /绑定 <邮箱>），
// 这里只提供登录用户查看状态与解绑，不再生成网站绑定码。
router.get('/chat-bind/status', botController.status)
router.delete('/chat-bind', botController.remove)

export { router as pointRoutes }
