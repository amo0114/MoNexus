import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Router, Request, Response, NextFunction } from 'express'
import multer, { MulterError } from 'multer'
import { config } from '../../config/index.js'
import { badRequest } from '../../lib/httpError.js'
import { authenticate, requireActiveUser, requireAdmin } from '../../middlewares/auth.js'
import { validate } from '../../middlewares/validate.js'
import {
  createPortableBackupSchema,
  portableBackupIdParamSchema,
} from './schema.js'
import * as controller from './controller.js'

const router = Router()
const importDirectory = path.join(config.portableBackupWorkDir, 'uploads')
fs.mkdirSync(importDirectory, { recursive: true, mode: 0o700 })

const importUpload = multer({
  storage: multer.diskStorage({
    destination: importDirectory,
    filename: (_req, _file, callback) => callback(null, `${crypto.randomUUID()}.monexus-backup`),
  }),
  limits: { fileSize: config.portableBackupMaxBytes, files: 1 },
})

function attachBackup(req: Request, res: Response, next: NextFunction) {
  importUpload.single('backup')(req, res, (err: unknown) => {
    if (err instanceof MulterError && err.code === 'LIMIT_FILE_SIZE') {
      next(badRequest('备份文件超过服务器允许的大小', 'FILE_TOO_LARGE'))
      return
    }
    if (err) {
      next(err)
      return
    }
    next()
  })
}

router.use(authenticate, requireActiveUser, requireAdmin)

router.post('/export', validate(createPortableBackupSchema), controller.create)
router.get('/:id', validate({ params: portableBackupIdParamSchema }), controller.status)
router.get('/:id/download', validate({ params: portableBackupIdParamSchema }), controller.download)
router.post('/import', attachBackup, controller.restore)

export { router as portableBackupRoutes }
