import { createHmac } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { config } from '../../config/index.js'
import { notFound, HttpError, type ErrorCode } from '../../lib/httpError.js'
import { getSystemConfigValue } from '../../lib/systemConfig.js'
import { getDeliveryStorage } from '../../lib/storage/delivery.js'
import { getProductFulfillmentMode, normalizeOrderStatus } from './fulfillment.js'

/**
 * P5 T5：受控文件下载的唯一发放入口。
 *
 * 语义要点（设计 §4/§5）：
 * - 防枚举：订单不存在 / 不属于请求者 / 该订单本无文件交付 → 统一 404，
 *   与"订单不存在"不可区分。只有确认归属后被状态规则拒绝才 403。
 * - 授权矩阵：买家受状态与窗口约束；商家对自己订单任何状态可下（举证）；
 *   管理员任何状态可下（仲裁）。revoked 文件仅管理员可下（取证）。
 * - 审计边界（如实声明）：FileGrantLog 覆盖"已解析到订单文件"的授权决策
 *   （granted 与 denied_state/window/revoked/subscription）。防枚举 404
 *   （无可挂接的文件外键）与 429 限流（防审计表被刷爆）不落审计。IP 只存
 *   HMAC，UA 截断 256。
 * - P7a：整个发放流程处于「请求者 × 订单」advisory xact lock 内——count→
 *   audit 串行化，限流计数不再可超发（DB 锁，跨实例成立）。锁后全部 DB
 *   调用走同一 tx 连接（含 getSystemConfigValue），deliveryKeyLock 同款
 *   纪律。拒绝也要落审计行，而事务内抛错会回滚——临界区返回结果对象，
 *   事务提交后再抛 HTTP 错误，denied 落行语义与 P5 逐字一致。
 * - 固有限制：presigned URL 一经签出，TTL 内无法撤销——所有拒绝只作用于
 *   "新签发"。
 */

const GRANT_RATE_LIMIT = 10
const GRANT_RATE_WINDOW_MS = 60_000

// P7a：发放临界区的 advisory lock 命名空间（classid），与 deliveryKeyLock
// 的 20260726 区分。hashtext 撞号只造成不同键对偶发的无谓串行，无害。
const FILE_GRANT_LOCK_CLASS = 20260727

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

interface GrantOutcome {
  error?: HttpError
  payload?: { url: string; expiresAt: Date; fileName: string; size: number }
}

export async function issueOrderFileDownloadUrl(orderId: number, requester: RequesterContext) {
  const result = await prisma.$transaction(
    async tx => {
      // 锁键 = 限流维度（orderId × userId）。presign 是本地签名计算，
      // 临界区毫秒级；maxWait 覆盖同键排队等锁前拿连接的上限。
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${FILE_GRANT_LOCK_CLASS}::int4, hashtext(${`${orderId}:${requester.userId}`}))`
      return resolveGrant(tx, orderId, requester)
    },
    { maxWait: 10_000, timeout: 15_000 }
  )
  if (result.error) throw result.error
  return result.payload!
}

async function resolveGrant(
  tx: Prisma.TransactionClient,
  orderId: number,
  requester: RequesterContext
): Promise<GrantOutcome> {
  const order = await tx.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      userId: true,
      status: true,
      merchantId: true,
      deliveryModeSnapshot: true,
      delivery: {
        select: {
          fileId: true,
          deliveredAt: true,
          // P6a：订阅到期时刻——订阅交付豁免平台下载窗口，只受它约束。
          expiresAt: true,
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
      const merchant = await tx.merchant.findUnique({
        where: { userId: requester.userId },
        select: { id: true },
      })
      if (merchant && merchant.id === order.merchantId) role = 'merchant'
    }
  }

  const file = order?.delivery?.file ?? null
  if (!order || !role || !file) {
    return { error: notFound('订单不存在') }
  }

  // 专用限流：按"请求者 × 订单"维度，audit 表就是计数器（多实例一致，
  // 且刷限流的行为本身留痕）。超限请求不再写审计行。count→create 在本
  // 事务的 advisory lock 内串行（P7a），并发不会超发。
  const recentGrants = await tx.fileGrantLog.count({
    where: {
      orderId: order.id,
      userId: requester.userId,
      createdAt: { gte: new Date(Date.now() - GRANT_RATE_WINDOW_MS) },
    },
  })
  if (recentGrants >= GRANT_RATE_LIMIT) {
    return { error: new HttpError(429, 'RATE_LIMITED', '请求过于频繁，请稍后再试') }
  }

  const audit = async (outcome: string, expiresAt?: Date) => {
    await tx.fileGrantLog.create({
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
      // 人工服务订单：附件只有交付完成才对买家生效。争议解回 processing
      // （商家将重新交付）时，旧附件不能继续下载——否则"发起争议→商家收回
      // 重做"的语义被旧文件绕过（评审 P1）。固定文件订单不受此限（付款即
      // 视为可交付，pending/processing 仅是结算中间态）。
      if (
        getProductFulfillmentMode(order.deliveryModeSnapshot) === 'manual_service'
        && status !== 'delivered' && status !== 'closed'
      ) {
        throw new FileAccessDenied('FILE_ACCESS_SUSPENDED', '订单尚未交付完成，文件暂不可下载', 'denied_state')
      }
      const windowDays = await getSystemConfigValue('fileAccessWindowDays', tx)
      // 复审 P2-3：订阅交付（expiresAt 非空）只受自身有效期约束——平台默认
      // 30 天窗口不得覆盖商家售出的更长订阅承诺（如 365 天）。
      if (windowDays > 0 && order.delivery?.deliveredAt && order.delivery.expiresAt == null) {
        const expiry = order.delivery.deliveredAt.getTime() + windowDays * 24 * 60 * 60 * 1000
        if (Date.now() > expiry) {
          throw new FileAccessDenied('FILE_WINDOW_EXPIRED', '下载窗口已过期，请联系商家', 'denied_window')
        }
      }
      // P6a：订阅交付按自身有效期拒新签发（商家/管理员不受限：履约凭据/
      // 仲裁取证）。审计 outcome 细分 denied_subscription（复审 P2-4：窗口
      // 规则与订阅规则的拒绝在仲裁时必须可区分，CHECK 词表已扩迁移）。
      if (order.delivery?.expiresAt && Date.now() > order.delivery.expiresAt.getTime()) {
        throw new FileAccessDenied('FILE_SUBSCRIPTION_EXPIRED', '订阅已过期，续费后可恢复下载', 'denied_subscription')
      }
    }

    const ttlRaw = await getSystemConfigValue('fileUrlTtlSeconds', tx)
    const ttlSeconds = Math.min(Math.max(ttlRaw, 30), 3600)
    const storage = await getDeliveryStorage()
    const { url, expiresAt } = await storage.presignDownload(file.key, file.fileName, ttlSeconds)

    await audit('granted', expiresAt)
    return { payload: { url, expiresAt, fileName: file.fileName, size: file.size } }
  } catch (err) {
    if (err instanceof FileAccessDenied) {
      await audit(err.outcome)
      return { error: err }
    }
    // 非业务异常（DB/存储故障）照常抛出——回滚整个事务，不留半途审计。
    throw err
  }
}
