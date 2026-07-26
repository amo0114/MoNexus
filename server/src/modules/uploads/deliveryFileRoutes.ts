import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { Router, type Request } from 'express'
import busboy from 'busboy'
import { authenticate, requireActiveUser, requireMerchant } from '../../middlewares/auth.js'
import { badRequest, HttpError } from '../../lib/httpError.js'
import { prisma } from '../../lib/prisma.js'
import { getDeliveryStorage } from '../../lib/storage/delivery.js'
import { FileTooLargeError, TMP_KEY_PREFIX, sanitizeFileName } from '../../lib/storage/deliveryTypes.js'
import { DeliveryMemoryStorage, verifyDeliveryToken } from '../../lib/storage/deliveryMemory.js'
import { getSystemConfigValue } from '../../lib/systemConfig.js'
import { withDeliveryKeyLock } from '../../lib/deliveryKeyLock.js'

const router = Router()

/**
 * 从原始文件名提取安全扩展名（最终对象键 <sha256>.<ext> 用）。
 * 仅接受短字母数字扩展；其余一律 bin——键里的扩展名只是运维辨识用，
 * 下载时的类型/名称都来自 DeliveryFile 行与签名参数。
 */
function safeExt(fileName: string): string {
  const ext = path.extname(fileName).slice(1).toLowerCase()
  return /^[a-z0-9]{1,10}$/.test(ext) ? ext : 'bin'
}

async function myMerchantId(req: Request): Promise<number> {
  const merchant = await prisma.merchant.findUniqueOrThrow({
    where: { userId: req.user!.userId },
    select: { id: true },
  })
  return merchant.id
}

/**
 * P5 T1：交付文件流式上传。与图片上传（memory multer，5MB）完全分离：
 * multipart 流经哈希计量直传私有桶临时键（恒定内存），完成后按
 * <sha256>.<ext> 去重晋升为最终键，登记 DeliveryFile 行返回 fileId。
 * 响应不含对象键——普通 API 永不返回 key/bucket。
 */
router.post('/delivery-file', authenticate, requireActiveUser, requireMerchant, async (req, res, next) => {
  let settled = false
  const fail = (err: unknown) => {
    if (settled) return
    settled = true
    // 中止解析，避免继续吞剩余请求体。
    req.unpipe()
    next(err instanceof HttpError ? err : err instanceof Error ? err : new Error(String(err)))
  }

  try {
    const maxMb = await getSystemConfigValue('deliveryFileMaxMb')
    const maxBytes = maxMb * 1024 * 1024
    const storage = await getDeliveryStorage()
    const merchantId = await myMerchantId(req)

    const bb = busboy({
      headers: req.headers,
      limits: { files: 1, fields: 0 },
      // multipart 头默认按 latin1 解码，中文文件名会变乱码。
      defParamCharset: 'utf8',
    })

    let handled = false
    bb.on('file', (_field, fileStream, info) => {
      handled = true
      void (async () => {
        const tmpKey = `${TMP_KEY_PREFIX}${randomUUID()}`
        try {
          const { sha256, size } = await storage.putStream(tmpKey, fileStream, maxBytes)
          if (size === 0) {
            await storage.delete(tmpKey).catch(() => {})
            throw badRequest('不能上传空文件')
          }
          const finalKey = `${sha256}.${safeExt(info.filename ?? '')}`
          const fileName = sanitizeFileName(info.filename ?? '')
          // 建行失败时**绝不**在请求路径删最终对象（失败默认保留）：
          // 建行失败最可能与数据库不可用相关，此刻的"兄弟行查询"同样不可信，
          // 误删会波及历史订单正引用的同 hash 文件。无行引用的最终对象由
          // cleanupUnreferencedObjects 按 24h 宽限期兜底清理（评审 P0）。
          // promote → create 全程持有该 key 的 advisory lock：否则孤儿 GC
          // 可能在"promote 去重命中、行尚未建成"的窗口删掉对象，让新行
          // 指向不存在的对象（评审 P0 竞态）。
          const file = await withDeliveryKeyLock(finalKey, async () => {
            await storage.promote(tmpKey, finalKey)
            return prisma.deliveryFile.create({
              data: {
                key: finalKey,
                fileName,
                size,
                // busboy 报告的 MIME 来自客户端，仅记录不信任。
                mimeType: info.mimeType || 'application/octet-stream',
                sha256,
                merchantId,
              },
              select: { id: true, fileName: true, size: true, createdAt: true },
            })
          })
          if (!settled) {
            settled = true
            res.status(201).json(file)
          }
        } catch (err) {
          if (err instanceof FileTooLargeError) {
            fail(badRequest(`文件大小不能超过 ${maxMb}MB`, 'FILE_TOO_LARGE'))
          } else {
            fail(err)
          }
        }
      })()
    })
    bb.on('error', fail)
    bb.on('finish', () => {
      if (!handled) fail(badRequest('未选择文件', 'NO_FILE'))
    })

    req.pipe(bb)
  } catch (err) {
    fail(err)
  }
})

/**
 * memory 适配器的"签名下载"透传：HMAC token 校验（篡改/过期 → 403，与
 * 真实 S3 签名失败同语义），响应头与 S3 版逐项对齐——强制 attachment +
 * octet-stream + no-store。生产（S3/MinIO）下 URL 直指对象存储，不走这里。
 */
router.get('/delivery-signed/:token', async (req, res, next) => {
  try {
    const storage = await getDeliveryStorage()
    if (!(storage instanceof DeliveryMemoryStorage)) {
      res.status(404).end()
      return
    }
    const payload = verifyDeliveryToken(req.params.token)
    if (!payload) {
      res.status(403).json({ error: { code: 'SIGNATURE_INVALID', message: '签名无效或已过期' } })
      return
    }
    const blob = storage.getBlob(payload.key)
    if (!blob) {
      res.status(404).end()
      return
    }
    res.setHeader('Content-Type', 'application/octet-stream')
    res.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(payload.fileName || 'download')}`
    )
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Cache-Control', 'no-store')
    res.send(blob)
  } catch (err) {
    next(err)
  }
})

export { router as deliveryFileRoutes }
