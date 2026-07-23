import { Request, Response, NextFunction } from 'express'
import * as announcementService from './service.js'

export async function listPublic(req: Request, res: Response, next: NextFunction) {
  try {
    const { audience } = req.query as { audience?: 'all' | 'user' | 'merchant' | 'admin' }
    res.json(await announcementService.listPublicAnnouncements(audience))
  } catch (err) {
    next(err)
  }
}
