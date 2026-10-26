import { createHmac } from 'node:crypto'
import type { RequestHandler } from 'express'
import { config } from '../../../config/index.js'
import { verifyProtocolV2 } from '../../../lib/signedProtocolV2.js'
import { runRedisCommandWithTimeout } from '../../../lib/redis.js'
import { HttpError, abuseProtectionUnavailable, unauthenticated } from '../../../lib/httpError.js'
import { unavailable } from '../../xboardAccounts/settings.js'

export const requireXboardBotEnabled: RequestHandler = (_req, _res, next) => {
  if (!config.xboardAccounts.enabled || !config.chatBot.enabled) return next(unavailable())
  next()
}

export const verifyXboardBotSignature: RequestHandler = async (req, _res, next) => {
  try {
    if (!config.chatBot.enabled) throw unavailable()
    const names = ['x-monexus-signature-version', 'x-monexus-timestamp', 'x-monexus-nonce', 'x-monexus-signature']
    for (const name of names) {
      if (req.rawHeaders.filter((_, i) => i % 2 === 0 && req.rawHeaders[i].toLowerCase() === name).length !== 1) throw unauthenticated('机器人签名无效')
    }
    const timestamp = req.get('x-monexus-timestamp') ?? '', nonce = req.get('x-monexus-nonce') ?? ''
    if (!Buffer.isBuffer(req.body) || !/^(0|[1-9][0-9]{0,15})$/.test(timestamp)
      || req.get('x-monexus-signature-version') !== '2'
      || !/^application\/json(?:;\s*charset=utf-8)?$/i.test(req.get('content-type') ?? '')
      || req.get('content-encoding')) throw unauthenticated('机器人签名无效')
    if (!verifyProtocolV2({ audience: 'bot', method: req.method, path: req.originalUrl,
      timestampMs: Number(timestamp), nonce, rawBody: req.body }, req.get('x-monexus-signature') ?? '', config.chatBot.secret)) throw unauthenticated('机器人签名无效')
    const key = `${config.cacheKeyPrefix}:bot:v2:nonce:${createHmac('sha256', config.chatBot.secret).update(nonce).digest('hex')}`
    let consumed: unknown
    try { consumed = await runRedisCommandWithTimeout('bot_v2_nonce', client => client.set(key, '1', 'PX', 601000, 'NX')) }
    catch { throw abuseProtectionUnavailable() }
    if (consumed === null) throw new HttpError(409, 'BOT_REQUEST_REPLAYED', '请求已处理，请使用新的签名重试')
    if (consumed !== 'OK') throw abuseProtectionUnavailable()
    try { req.body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(req.body)) }
    catch { throw new HttpError(400, 'VALIDATION_ERROR', 'JSON 格式无效') }
    next()
  } catch (error) { next(error) }
}
