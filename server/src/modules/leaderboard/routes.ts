import { Router } from 'express'
import { authenticate, requireActiveUser } from '../../middlewares/auth.js'
import { validate } from '../../middlewares/validate.js'
import * as controller from './controller.js'
import { LeaderboardQuerySchema } from './schemas.js'

const router = Router()

// 与 points 模块同姿态：登录 + 未封禁即可读；榜单不含他人身份信息，
// 无需更强的角色门。
router.use(authenticate, requireActiveUser)
router.get('/', validate({ query: LeaderboardQuerySchema }), controller.leaderboard)

export { router as leaderboardRoutes }
