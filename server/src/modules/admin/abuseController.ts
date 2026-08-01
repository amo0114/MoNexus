import type { NextFunction, Request, Response } from 'express'
import * as abuseService from './abuseService.js'
import type {
  AbuseOverviewQuery,
  ListAbuseReferralsQuery,
  ListAbuseRewardsQuery,
} from './schema.js'

export async function overview(req: Request, res: Response, next: NextFunction) {
  try {
    const { window } = req.query as unknown as AbuseOverviewQuery
    res.json(await abuseService.getAbuseOverview(window))
  } catch (error) {
    next(error)
  }
}

export async function referrals(req: Request, res: Response, next: NextFunction) {
  try {
    res.json(await abuseService.listAbuseReferrals(req.query as unknown as ListAbuseReferralsQuery))
  } catch (error) {
    next(error)
  }
}

export async function rewards(req: Request, res: Response, next: NextFunction) {
  try {
    res.json(await abuseService.listAbuseRewards(req.query as unknown as ListAbuseRewardsQuery))
  } catch (error) {
    next(error)
  }
}

export async function setReferralSuspension(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.params.id as unknown as number
    res.json(await abuseService.setReferralSuspension({
      adminUserId: req.user!.userId,
      userId,
      suspended: req.body.suspended,
      caseRef: req.body.caseRef,
    }))
  } catch (error) {
    next(error)
  }
}

export async function voidReward(req: Request, res: Response, next: NextFunction) {
  try {
    const rewardId = req.params.id as unknown as number
    res.json(await abuseService.voidAbuseReward({
      adminUserId: req.user!.userId,
      rewardId,
      caseRef: req.body.caseRef,
    }))
  } catch (error) {
    next(error)
  }
}
