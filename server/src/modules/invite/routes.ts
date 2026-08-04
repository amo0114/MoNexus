import { Router } from 'express'
import { authenticate, requireActiveUser } from '../../middlewares/auth.js'
import * as controller from './controller.js'

const router = Router()

// 登录 + 未封禁即可访问：资格判定（等级/验证/账龄/暂停）是 service 的领域
// 规则（IV-04），不是路由角色门——admin 与普通用户走同一入口。
router.use(authenticate, requireActiveUser)
router.get('/me', controller.myInvites)
router.post('/', controller.createInvite)

export { router as inviteRoutes }
