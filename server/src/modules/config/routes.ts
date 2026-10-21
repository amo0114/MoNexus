import { Router } from 'express'
import * as controller from './controller.js'
import { authenticateIfPresent, requireActiveUserIfPresent } from '../../middlewares/auth.js'

const router = Router()

// Public read-only metadata for UI labels, tones, and operational display defaults.
//
// SPEC-CATALOG-VIS-001 §3.4：解析**可选**登录态——不登录也能读，但登录用户
// 应拿到包含受限分类的完整 registry。复用既有 optional-auth 中间件，
// 不新增鉴权逻辑；requireActiveUserIfPresent 保证 token 有效但账号已停用时
// 按原 auth 错误处理，不会静默降级成 member（也不会降级成 guest 掩盖问题）。
router.get(
  '/registry',
  authenticateIfPresent,
  requireActiveUserIfPresent,
  controller.registry,
)

export { router as configRoutes }
