import type { Request, Response, NextFunction } from 'express'
import * as announcementAdminService from './adminService.js'
import type { ListAnnouncementsQuery } from './adminSchema.js'

// ---- Announcements ----

export async function listAnnouncementsRoute(req: Request, res: Response, next: NextFunction) {
  try {
    res.json(await announcementAdminService.listAnnouncements(req.query as unknown as ListAnnouncementsQuery))
  } catch (err) { next(err) }
}

export async function createAnnouncementRoute(req: Request, res: Response, next: NextFunction) {
  try {
    res.status(201).json(await announcementAdminService.createAnnouncement(req.user!.userId, req.body))
  } catch (err) { next(err) }
}

export async function updateAnnouncementRoute(req: Request, res: Response, next: NextFunction) {
  try {
    const id = req.params.id as unknown as number
    res.json(await announcementAdminService.updateAnnouncement(req.user!.userId, id, req.body))
  } catch (err) { next(err) }
}

export async function deleteAnnouncementRoute(req: Request, res: Response, next: NextFunction) {
  try {
    const id = req.params.id as unknown as number
    res.json(await announcementAdminService.deleteAnnouncement(req.user!.userId, id))
  } catch (err) { next(err) }
}
