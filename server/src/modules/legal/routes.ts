import { Router } from 'express'
import * as controller from './controller.js'

/**
 * SPEC-LEGAL-001：公开法律文档路由（无鉴权——注册页/下单弹窗的协议链接
 * 必须对未登录访客可达）。功能关闭时一律 404，不暴露特性状态。
 */
const router = Router()

router.get('/documents', controller.listDocuments)
router.get('/documents/:slug', controller.getDocument)

export { router as legalRoutes }
