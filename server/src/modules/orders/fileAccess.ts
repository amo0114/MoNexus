import { createHmac } from 'node:crypto'
import { prisma } from '../../lib/prisma.js'
import { config } from '../../config/index.js'
import { notFound, HttpError, type ErrorCode } from '../../lib/httpError.js'
import { getSystemConfigValue } from '../../lib/systemConfig.js'
import { getDeliveryStorage } from '../../lib/storage/delivery.js'
import { normalizeOrderStatus } from './fulfillment.js'

/**
 * P5 T5：受控文件下载的唯一发放入口。
 *
 * 语义要点（设计 §4/§5）：
 * - 防枚举：订单不存在 / 不属于请求者 / 该订单本无文件交付 → 统一 404，
 *   与"订单不存在"不可区分。只有确认归属后被状态规则拒绝才 403。
 * - 授权矩阵：买家受状态与窗口约束；商家对自己订单任何状态可下（举证）；
 *   管理员任何状态可下（仲裁）。revoked 文件仅管理员可下（取证）。
 * - 审计：granted/denied 全部落 FileGrantLog；IP 只存 HMAC，UA 截断。
 * - 固有限制：presigned URL 一经签出，TTL 内无法撤销——所有拒绝只作用于
 *   "新签发"。
 */

const GRANT_RATE_LIMIT = 10
const GRANT_RATE_WINDOW_MS = 60_000

export type FileAccessRole = 'buyer' | 'merchant' | 'admin'

interface RequesterContext {
  userId: number
  userRole: string
  ip?: string
  userAgent?: string
}

function hashIp(ip: string | undefined): string | null {
  if (!ip) return null
  return createHmac('sha256', config.jwtSecret).update(`file-grant-ip:${ip}`).digest('hex').slice(0, 32)
}

class FileAccessDenied extends HttpError {
  constructor(code: ErrorCode, message: string, public readonly outcome: string) {
    super(403, code, message)
  }
}

export async function issueOrderFileDownloadUrl(orderId: number, requester: RequesterContext) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      userId: true,
      status: true,
      merchantId: true,
      delivery: {
        select: {
          fileId: true,
          deliveredAt: true,
          file: { select: { id: true, key: true, fileName: true, size: true, status: true } },
        },
      },
    },
  })

  // 角色解析先于存在性响应——但对外统一 404，防止用探测差异枚举订单/文件。
  let role: FileAccessRole | null = null
  if (order) {
    if (order.userId === requester.userId) {
      role = 'buyer'
    } else if (requester.userRole === 'admin') {
      role = 'admin'
    } else if (requester.userRole === 'merchant' && order.merchantId != null) {
      const merchant = await prisma.merchant.findUnique({
        where: { userId: requester.userId },
        select: { id: true },
      })
      if (merchant && merchant.id === order.merchantId) role = 'merchant'
    }
  }

  const file = order?.delivery?.file ?? null
  if (!order || !role || !file) {
    throw notFound('订单不存在')
  }

  // 专用限流：按"请求者 × 订单"维度，audit 表就是计数器（多实例一致，
  // 且刷限流的行为本身留痕）。超限请求不再写审计行。
  const recentGrants = await prisma.fileGrantLog.count({
    where: {
      orderId: order.id,
      userId: requester.userId,
      createdAt: { gte: new Date(Date.now() - GRANT_RATE_WINDOW_MS) },
    },
  })
  if (recentGrants >= GRANT_RATE_LIMIT) {
    throw new HttpError(429, 'RATE_LIMITED', '请求过于频繁，请稍后再试')
  }

  const audit = async (outcome: string, expiresAt?: Date) => {
    await prisma.fileGrantLog.create({
      data: {
        fileId: file.id,
        orderId: order.id,
        userId: requester.userId,
        role: role!,
        outcome,
        ipHash: hashIp(requester.ip),
        userAgent: requester.userAgent?.slice(0, 256) ?? null,
        expiresAt: expiresAt ?? null,
      },
    })
  }

  try {
    // 吊销/已清理：仅管理员可下 revoked（取证）；对象已删则谁都签不出。
    if (file.status === 'deleted') {
      throw new FileAccessDenied('FILE_ACCESS_REVOKED', '文件已被清理', 'denied_revoked')
    }
    if (file.status === 'revoked' && role !== 'admin') {
      throw new FileAccessDenied('FILE_ACCESS_REVOKED', '文件已被平台下架', 'denied_revoked')
    }

    if (role === 'buyer') {
      const status = normalizeOrderStatus(order.status)
      if (status === 'disputed') {
        throw new FileAccessDenied('FILE_ACCESS_SUSPENDED', '订单争议处理中，文件下载已暂停', 'denied_state')
      }
      if (status === 'refunded') {
        throw new FileAccessDenied('FILE_ACCESS_REVOKED', '订单已退款，文件不再可下载', 'denied_state')
      }
      const windowDays = await getSystemConfigValue('fileAccessWindowDays')
      if (windowDays > 0 && order.delivery?.deliveredAt) {
        const expiry = order.delivery.deliveredAt.getTime() + windowDays * 24 * 60 * 60 * 1000
        if (Date.now() > expiry) {
          throw new FileAccessDenied('FILE_WINDOW_EXPIRED', '下载窗口已过期，请联系商家', 'denied_window')
        }
      }
    }

    const ttlRaw = await getSystemConfigValue('fileUrlTtlSeconds')
    const ttlSeconds = Math.min(Math.max(ttlRaw, 30), 3600)
    const storage = await getDeliveryStorage()
    const { url, expiresAt } = await storage.presignDownload(file.key, file.fileName, ttlSeconds)

    await audit('granted', expiresAt)
    return { url, expiresAt, fileName: file.fileName, size: file.size }
  } catch (err) {
    if (err instanceof FileAccessDenied) {
      await audit(err.outcome)
    }
    throw err
  }
}
