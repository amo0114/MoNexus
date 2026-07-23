import { Request, Response, NextFunction } from 'express'
import * as announcementService from './service.js'

export async function listPublic(req: Request, res: Response, next: NextFunction) {
  try {
    const audience = req.user?.role === 'user' || req.user?.role === 'merchant' || req.user?.role === 'admin'
      ? req.user.role
      : undefined
    res.json(await announcementService.listPublicAnnouncements(audience))
  } catch (err) {
    next(err)
  }
}
