import { Request, Response, NextFunction } from 'express'
import { prisma } from '../../lib/prisma.js'
import * as announcementService from './service.js'

type AnnouncementAudience = 'user' | 'merchant' | 'admin'

/**
 * This endpoint remains public, so an invalid current account is deliberately
 * treated like a visitor instead of turning an announcement banner into a
 * protected resource. Never derive a targeted audience from a stale JWT role.
 */
async function resolveCurrentAudience(userId?: number): Promise<AnnouncementAudience | undefined> {
  if (!userId) return undefined

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      role: true,
      status: true,
      merchant: { select: { status: true } },
    },
  })
  if (!user || user.status !== '正常') return undefined

  if (user.role === 'admin') return 'admin'
  // A suspended merchant cannot fall through to the ordinary-user audience:
  // that would still expose user-targeted operational messages to a stale
  // merchant session.
  if (user.role === 'merchant') return user.merchant?.status === 'active' ? 'merchant' : undefined
  return 'user'
}

export async function listPublic(req: Request, res: Response, next: NextFunction) {
  try {
    const audience = await resolveCurrentAudience(req.user?.userId)
    // Keep the documented visitor fallback complete: an invalid, banned or
    // suspended current account may see only public/all notices, but must not
    // receive user-specific receipt state from an otherwise stale JWT.
    res.json(await announcementService.listPublicAnnouncements(audience, audience ? req.user?.userId : undefined))
  } catch (err) {
    next(err)
  }
}

export async function markRead(req: Request, res: Response, next: NextFunction) {
  try {
    const audience = await resolveCurrentAudience(req.user!.userId)
    const id = req.params.id as unknown as number
    res.json(await announcementService.markAnnouncementRead(id, req.user!.userId, audience))
  } catch (err) {
    next(err)
  }
}

export async function acknowledge(req: Request, res: Response, next: NextFunction) {
  try {
    const audience = await resolveCurrentAudience(req.user!.userId)
    const id = req.params.id as unknown as number
    res.json(await announcementService.acknowledgeAnnouncement(id, req.user!.userId, audience))
  } catch (err) {
    next(err)
  }
}
