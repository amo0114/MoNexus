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
    res.json(await pointService.getCheckinStatus(req.user!.userId))
  } catch (err) {
    next(err)
  }
}

export async function makeup(req: Request, res: Response, next: NextFunction) {
  try {
    const { date, expectedPrice } = req.body as { date: string; expectedPrice: number }
    res.json(await pointService.makeupCheckin(req.user!.userId, date, expectedPrice))
  } catch (err) {
    next(err)
  }
}

export async function claimReward(req: Request, res: Response, next: NextFunction) {
  try {
    const { id } = req.params as unknown as { id: number }
    res.json(await pointService.claimCheckinReward(req.user!.userId, Number(id)))
  } catch (err) {
    next(err)
  }
}

export async function tier(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await pointService.getTier(req.user!.userId)
    res.json(result)
  } catch (err) {
    next(err)
  }
}
