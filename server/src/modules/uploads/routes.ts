import { Router, Request, Response, NextFunction } from 'express'
import multer, { MulterError } from 'multer'
import { authenticate, requireActiveUser, requireVerifiedEmail } from '../../middlewares/auth.js'
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

type AllowedImageMime = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

function startsWith(buffer: Buffer, signature: number[]) {
  return buffer.length >= signature.length && signature.every((byte, index) => buffer[index] === byte)
}

function detectImageMime(buffer: Buffer): AllowedImageMime | null {
  if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) return 'image/webp'
  const gifHeader = buffer.subarray(0, 6).toString('ascii')
  if (gifHeader === 'GIF87a' || gifHeader === 'GIF89a') return 'image/gif'
  return null
}

const extensionByMime: Record<AllowedImageMime, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

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

// Keep this authorization guard ahead of multer: an unverified account must
// not make us parse, buffer, or persist a multipart payload at all.
router.post('/image', authenticate, requireActiveUser, requireVerifiedEmail, attachFile, async (req, res, next) => {
  if (!req.file) {
    return next(badRequest('未选择文件', 'NO_FILE'))
  }
  try {
    // Multer's MIME value comes from the client request. Verify magic bytes
    // and require an exact match before persisting either the blob or its
    // Content-Type, so arbitrary bytes cannot masquerade as an image.
    const detectedMime = detectImageMime(req.file.buffer)
    if (!detectedMime || detectedMime !== req.file.mimetype) {
      return next(badRequest('文件内容与图片格式不匹配', 'UNSUPPORTED_MEDIA_TYPE'))
    }
    const ext = extensionByMime[detectedMime]
    const storage = await getStorage()
    const result = await storage.put(req.file.buffer, {
      mimeType: detectedMime,
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
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
    res.send(blob.buffer)
  } catch (err) {
    next(err)
  }
})

export { router as uploadsRoutes }
