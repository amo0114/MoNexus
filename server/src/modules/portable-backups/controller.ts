import { Request, Response, NextFunction } from 'express'
import fs from 'node:fs/promises'
import { clearRefreshTokenCookie } from '../../lib/cookies.js'
import { badRequest } from '../../lib/httpError.js'
import { importPortableBackupSchema } from './schema.js'
import {
  getPortableBackupDownload,
  getPortableBackupJob,
  importPortableBackup,
  startPortableBackup,
} from './service.js'

export async function create(req: Request, res: Response, next: NextFunction) {
  try {
    const job = await startPortableBackup(req.user!.userId, req.body.passphrase)
    res.status(202).json(job)
  } catch (err) {
    next(err)
  }
}

export async function status(req: Request, res: Response, next: NextFunction) {
  try {
    res.json(getPortableBackupJob(req.user!.userId, String(req.params.id)))
  } catch (err) {
    next(err)
  }
}

export async function download(req: Request, res: Response, next: NextFunction) {
  try {
    const { filePath, fileName } = getPortableBackupDownload(req.user!.userId, String(req.params.id))
    res.download(filePath, fileName, {
      headers: {
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    }, err => {
      if (err && !res.headersSent) next(err)
    })
  } catch (err) {
    next(err)
  }
}

export async function restore(req: Request, res: Response, next: NextFunction) {
  const filePath = req.file?.path
  let handedToService = false
  try {
    if (!req.file || !filePath) throw badRequest('未选择备份文件', 'NO_FILE')
    const input = importPortableBackupSchema.safeParse(req.body)
    if (!input.success) throw input.error

    handedToService = true
    const result = await importPortableBackup(req.user!.userId, filePath, input.data.passphrase)
    // Restoring replaces the account table; the browser must not retain a
    // refresh cookie or access token associated with the pre-import database.
    clearRefreshTokenCookie(res)
    res.json(result)
  } catch (err) {
    if (!handedToService && filePath) await fs.rm(filePath, { force: true })
    next(err)
  }
}
