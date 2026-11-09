import { Request, Response, NextFunction } from 'express'
import { notFound } from '../../lib/httpError.js'
import { getWebPushPublicKey, isWebPushEnabled } from '../../lib/webPush.js'
import * as pushService from './service.js'
import type { SubscribeBody } from './schema.js'

function assertEnabled() {
  if (!isWebPushEnabled()) throw notFound('页面不存在')
}

export function publicKey(_req: Request, res: Response) {
  res.json({ enabled: isWebPushEnabled(), publicKey: getWebPushPublicKey() })
}

export async function subscribe(req: Request, res: Response, next: NextFunction) {
  try {
    assertEnabled()
    await pushService.subscribe(req.user!.userId, req.body as SubscribeBody, req.get('user-agent'))
    res.status(204).end()
  } catch (err) {
    next(err)
  }
}

export async function unsubscribe(req: Request, res: Response, next: NextFunction) {
  try {
    assertEnabled()
    await pushService.unsubscribe(req.user!.userId, (req.body as { endpoint: string }).endpoint)
    res.status(204).end()
  } catch (err) {
    next(err)
  }
}
