import { Router, Request, Response, NextFunction } from 'express'
import multer, { MulterError } from 'multer'
import { authenticate, requireActiveUser } from '../../middlewares/auth.js'
import { badRequest } from '../../lib/httpError.js'
import { getStorage } from '../../lib/storage/index.js'

const router = Router()

const MAX_FILE_SIZE = 5 * 1024 * 1024 // 5MB

const ALLOWED_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
])

// Sentinel error code that the attachFile wrapper translates into a
// 400 UNSUPPORTED_MEDIA_TYPE response. Using a sentinel avoids smuggling
// HttpError objects through multer's cb(err) signature.
const REJECTED_MIME = 'REJECTED_MIME'

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
      return cb(new Error(REJECTED_MIME))
    }
    cb(null, true)
  },
})

// Wrap multer.single so its errors map to our HttpError contract instead
// of Express's default 500. The global errorHandler doesn't know about
// MulterError on its own.
function attachFile(req: Request, res: Response, next: NextFunction) {
  upload.single('file')(req, res, (err: unknown) => {
    if (err instanceof MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return next(badRequest('文件大小不能超过 5MB', 'FILE_TOO_LARGE'))
      }
      return next(badRequest(err.message))
    }
    if (err instanceof Error && err.message === REJECTED_MIME) {
      return next(badRequest('仅支持 PNG / JPEG / WebP / GIF 图片', 'UNSUPPORTED_MEDIA_TYPE'))
    }
    if (err) return next(err)
    next()
  })
}

router.post('/image', authenticate, requireActiveUser, attachFile, async (req, res, next) => {
  if (!req.file) {
    return next(badRequest('未选择文件', 'NO_FILE'))
  }
  try {
    // mimetype like 'image/png' -> ext 'png'. We trust the fileFilter
    // above to have already rejected anything that isn't image/*.
    const ext = req.file.mimetype.split('/')[1]
    const storage = await getStorage()
    const result = await storage.put(req.file.buffer, {
      mimeType: req.file.mimetype,
      ext,
    })
    res.json(result)
  } catch (err) {
    next(err)
  }
})

// Public passthrough for the memory adapter — lets dev / test fetch
// uploaded blobs from the URL the POST returned. In production the
// returned URL points directly at the S3-compatible endpoint and this
// route is never hit.
router.get('/:key', async (req, res, next) => {
  try {
    const storage = await getStorage()
    const blob = await storage.get(req.params.key)
    if (!blob) {
      res.status(404).end()
      return
    }
    res.setHeader('Content-Type', blob.mimeType)
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
    res.send(blob.buffer)
  } catch (err) {
    next(err)
  }
})

export { router as uploadsRoutes }
