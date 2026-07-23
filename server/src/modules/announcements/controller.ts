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
    res.json(await announcementService.listPublicAnnouncements(audience))
  } catch (err) {
    next(err)
  }
}
