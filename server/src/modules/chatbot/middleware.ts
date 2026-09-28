import { createHmac } from 'node:crypto'
import type { Request, Response, NextFunction } from 'express'
import { config } from '../../config/index.js'
import { botSignaturesEqual, buildBotSignPayload, BOT_SIGNATURE_TOLERANCE_MS } from './service.js'

/**
 * SPEC-CHAT-BOT-001 — 机器人请求鉴权。
 *
 * 为什么不用 JWT：机器人是长期在线的服务进程，给它签一个长效 JWT 等于发放
 * 万能钥匙；一旦泄露，攻击者可直接以任意用户身份调用全站接口。这里改用
 * 共享密钥 HMAC：
 *   1. 只授权 /api/bot/* 这一小组接口，权限面收敛到绑定与签到查询
 *   2. 签名带 timestamp，超窗拒收，降低重放窗口
 *   3. 常量时间比较，避免时序侧信道
 *
 * 参与签名的字段：timestamp + 请求体字段 + 路由路径。路由路径必须参与，
 * 否则抓到一个合法签名就能把它挪用到另一个接口上。
 */

export interface BotSignedRequest extends Request {
  botBody?: Record<string, unknown>
}

function unauthorized(res: Response, message: string) {
  res.status(401).json({ error: { code: 'BOT_UNAUTHORIZED', message } })
}

export function requireBotSignature(req: Request, res: Response, next: NextFunction) {
  const secret = config.chatBot?.secret
  if (!secret) {
    res.status(503).json({
      error: { code: 'BOT_NOT_CONFIGURED', message: '机器人通道未配置（缺少 BOT_SHARED_SECRET）' },
    })
    return
  }

  const sign = req.header('x-bot-sign')
  const tsRaw = req.header('x-bot-timestamp')
  if (!sign || !tsRaw) {
    unauthorized(res, '缺少签名头')
    return
  }

  const timestamp = Number(tsRaw)
  if (!Number.isFinite(timestamp)) {
    unauthorized(res, '时间戳不合法')
    return
  }

  // 时钟偏移容忍窗。双向判断，未来时间同样拒收。
  if (Math.abs(Date.now() - timestamp) > BOT_SIGNATURE_TOLERANCE_MS) {
    unauthorized(res, '请求已过期，请检查服务器时间')
    return
  }

  const body = (req.body ?? {}) as Record<string, unknown>
  // 路由路径参与签名，防止签名被挪用到其它 bot 接口。
  const payloadParams: Record<string, unknown> = {
    ...body,
    timestamp,
    _path: req.path,
  }
  const expected = buildBotSignPayload(payloadParams)

  const digest = createHmac('sha256', secret).update(expected, 'utf8').digest('hex')

  if (!botSignaturesEqual(digest, sign)) {
    unauthorized(res, '签名校验失败')
    return
  }

  ;(req as BotSignedRequest).botBody = body
  next()
}
