import { Router } from 'express'
import { authenticate, requireActiveUser } from '../../middlewares/auth.js'
import * as controller from './bindController.js'

const router = Router()

// SPEC-CHAT-BOT-001：绑定主路径在 QQ 群内完成（发 /绑定 <邮箱>），
// 这里只提供登录用户查看状态与解绑，不再生成网站绑定码。
// 鉴权挂在单条路由上：本路由与 pointRoutes 共用 /api/points 前缀，router.use 会让其余
// 积分接口重复鉴权。
router.get('/chat-bind/status', authenticate, requireActiveUser, controller.status)
router.delete('/chat-bind', authenticate, requireActiveUser, controller.remove)

export { router as chatBindRoutes }
