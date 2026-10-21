import { Request, Response, NextFunction } from 'express'
import * as configService from './service.js'
import { resolveProductAudience } from '../products/visibility.js'

export async function registry(req: Request, res: Response, next: NextFunction) {
  try {
    // SPEC-CATALOG-VIS-001 §3.4：按可选登录态输出分类视角。
    // 无 token ⇒ req.user 为空 ⇒ guest；上限由 requireActiveUserIfPresent 保证。
    res.set('Cache-Control', 'private, no-store')
    res.json(await configService.getConfigRegistry(resolveProductAudience(req.user)))
  } catch (err) {
    next(err)
  }
}
