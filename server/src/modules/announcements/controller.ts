import { Request, Response, NextFunction } from 'express'
import { prisma } from '../../lib/prisma.js'
import { getAdminMfaSessionState, type AuthPayload } from '../../middlewares/auth.js'
import * as announcementService from './service.js'

type AnnouncementAudience = 'user' | 'merchant' | 'admin'

/**
 * This endpoint remains public, so an invalid current account is deliberately
 * treated like a visitor instead of turning an announcement banner into a
 * protected resource. Never derive a targeted audience from a stale JWT role.
 */
async function resolveCurrentAudience(auth?: AuthPayload): Promise<AnnouncementAudience | undefined> {
  if (!auth) return undefined

  const user = await prisma.user.findUnique({
    where: { id: auth.userId },
    select: {
      role: true,
      status: true,
      merchant: { select: { status: true } },
    },
  })
  if (!user || user.status !== '正常') return undefined

  // The endpoint itself stays public, but admin-targeted notices are not.
  // A stale/no-MFA administrator token deliberately falls back to visitor
  // visibility rather than receiving a different protected-route error.
  if (user.role === 'admin') {
    return (await getAdminMfaSessionState(auth)) === 'allowed' ? 'admin' : undefined
  }
  // A suspended merchant cannot fall through to the ordinary-user audience:
  // that would still expose user-targeted operational messages to a stale
  // merchant session.
  if (user.role === 'merchant') return user.merchant?.status === 'active' ? 'merchant' : undefined
  return 'user'
}

export async function listPublic(req: Request, res: Response, next: NextFunction) {
  try {
    const audience = await resolveCurrentAudience(req.user)
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
    const audience = await resolveCurrentAudience(req.user)
    const id = req.params.id as unknown as number
    res.json(await announcementService.markAnnouncementRead(id, req.user!.userId, audience))
  } catch (err) {
    next(err)
  }
}

export async function acknowledge(req: Request, res: Response, next: NextFunction) {
  try {
    const audience = await resolveCurrentAudience(req.user)
    const id = req.params.id as unknown as number
    res.json(await announcementService.acknowledgeAnnouncement(id, req.user!.userId, audience))
  } catch (err) {
    next(err)
  }
}
