import { Request, Response, NextFunction } from 'express'
import * as pointService from './service.js'

export async function checkin(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await pointService.checkin(req.user!.userId)
    res.json(result)
  } catch (err) {
    next(err)
  }
}

export async function history(req: Request, res: Response, next: NextFunction) {
  try {
    const logs = await pointService.getHistory(req.user!.userId)
    res.json(logs)
  } catch (err) {
    next(err)
  }
}

export async function checkinStatus(req: Request, res: Response, next: NextFunction) {
  try {
    const checked = await pointService.hasCheckedInToday(req.user!.userId)
    res.json({ hasCheckedIn: checked })
  } catch (err) {
    next(err)
  }
}
