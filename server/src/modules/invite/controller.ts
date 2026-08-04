import type { Request, Response, NextFunction } from 'express'
import { unauthenticated } from '../../lib/httpError.js'
import * as inviteService from './service.js'

export async function myInvites(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw unauthenticated('未登录')
    res.json(await inviteService.getMyInvites(req.user.userId))
  } catch (err) {
    next(err)
  }
}

export async function createInvite(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw unauthenticated('未登录')
    const created = await inviteService.createInviteCode(req.user.userId)
    res.status(201).json(created)
  } catch (err) {
    next(err)
  }
}
