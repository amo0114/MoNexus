import type { Request, Response, NextFunction } from 'express'
import * as botService from './service.js'

/**
 * SPEC-CHAT-BOT-001 —— 网站侧绑定管理（浏览器登录态）。
 *
 * 注意：这里**不再提供「生成绑定码」**。绑定主路径已改为在 QQ 群内发送
 * `/绑定 <邮箱>` 完成，用户无需回到网站。网站只保留「查看绑定状态」与
 * 「解绑」两个动作，供已经登录的用户管理自己的绑定关系。
 *
 * /api/bot/* 与这里的分工：
 * - 这里用用户 JWT，只能操作自己的绑定
 * - /api/bot/* 用 HMAC，由机器人代用户操作
 */

export async function status(req: Request, res: Response, next: NextFunction) {
  try {
    const binding = await botService.getBinding(req.user!.userId)
    res.json({
      bound: Boolean(binding),
      platform: binding?.platform ?? null,
      platformId: binding?.platformId ?? null,
      boundAt: binding?.createdAt ?? null,
    })
  } catch (err) {
    next(err)
  }
}

export async function remove(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await botService.unbind(req.user!.userId)
    res.json({ unbound: true, ...result })
  } catch (err) {
    next(err)
  }
}
