import { Request, Response, NextFunction } from 'express'
import { config } from '../../config/index.js'
import { notFound } from '../../lib/httpError.js'
import * as notificationService from './service.js'
import type { ListNotificationsQuery } from './schema.js'

function assertNotificationEnabled() {
  if (!config.notification.enabled) throw notFound('页面不存在')
}

export async function list(req: Request, res: Response, next: NextFunction) {
  try {
    assertNotificationEnabled()
    const query = req.query as unknown as ListNotificationsQuery
    res.json(await notificationService.listNotifications(req.user!.userId, query))
  } catch (err) {
    next(err)
  }
}

export async function unreadCount(req: Request, res: Response, next: NextFunction) {
  try {
    assertNotificationEnabled()
    res.json(await notificationService.getUnreadCount(req.user!.userId))
  } catch (err) {
    next(err)
  }
}

export async function markRead(req: Request, res: Response, next: NextFunction) {
  try {
    assertNotificationEnabled()
    const id = req.params.id as unknown as number
    res.json(await notificationService.markAsRead(req.user!.userId, id))
  } catch (err) {
    next(err)
  }
}

export async function markAllRead(req: Request, res: Response, next: NextFunction) {
  try {
    assertNotificationEnabled()
    res.json(await notificationService.markAllAsRead(req.user!.userId))
  } catch (err) {
    next(err)
  }
}
