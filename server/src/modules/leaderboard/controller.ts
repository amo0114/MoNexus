import type { Request, Response, NextFunction } from 'express'
import { unauthenticated } from '../../lib/httpError.js'
import * as leaderboardService from './service.js'
import type { LeaderboardQuery } from './schemas.js'

export async function leaderboard(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw unauthenticated('未登录')
    // scope 已由 validate({ query: LeaderboardQuerySchema }) 归一（缺省 total）。
    const { scope } = req.query as unknown as LeaderboardQuery
    const result = await leaderboardService.getLeaderboard(scope, req.user.userId)
    res.json(result)
  } catch (err) {
    next(err)
  }
}
