import bcrypt from 'bcryptjs'
import { prisma } from '../../lib/prisma.js'
import { HttpError, notFound } from '../../lib/httpError.js'
import { getSystemConfigValue } from '../../lib/systemConfig.js'

// 防爆破：验证失败按用户计数，窗口内连错达到上限后拒绝继续尝试。
// 单实例内存计数即可（当前部署形态）；多实例化时迁移到 Redis。
const MAX_FAILED_ATTEMPTS = 5
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000

const failedAttempts = new Map<number, { count: number; resetAt: number }>()

/** 测试隔离用：清空失败计数。 */
export function resetVerificationAttempts() {
  failedAttempts.clear()
}

function registerFailure(userId: number) {
  const now = Date.now()
  const entry = failedAttempts.get(userId)
  if (!entry || entry.resetAt <= now) {
    failedAttempts.set(userId, { count: 1, resetAt: now + ATTEMPT_WINDOW_MS })
    return
  }
  entry.count += 1
}

function assertNotLocked(userId: number) {
  const entry = failedAttempts.get(userId)
  if (!entry) return
  if (entry.resetAt <= Date.now()) {
    failedAttempts.delete(userId)
    return
  }
  if (entry.count >= MAX_FAILED_ATTEMPTS) {
    throw new HttpError(429, 'TOO_MANY_ATTEMPTS', '验证失败次数过多，请稍后再试')
  }
}

/**
 * 高风险订单二次验证的触发判定（spec P3：首版仅金额维度）。
 * - 单笔金额 ≥ checkoutVerifyAmountThreshold（0 = 关闭）
 * - 当日已成交累计 + 本单 ≥ checkoutVerifyDailyThreshold（0 = 关闭）
 * 当日口径：服务器本地日界；退款单不计入（用户实际未支出）。
 * 并发下两笔订单可能都按"累计未超"放行——阈值是风控软措施，
 * 不是记账不变量，不为此加锁。
 */
export async function resolveVerificationRequirement(userId: number, price: number): Promise<boolean> {
  const [amountThreshold, dailyThreshold] = await Promise.all([
    getSystemConfigValue('checkoutVerifyAmountThreshold'),
    getSystemConfigValue('checkoutVerifyDailyThreshold'),
  ])

  if (amountThreshold > 0 && price >= amountThreshold) return true

  if (dailyThreshold > 0) {
    const startOfDay = new Date()
    startOfDay.setHours(0, 0, 0, 0)
    const spent = await prisma.order.aggregate({
      _sum: { price: true },
      where: {
        userId,
        createdAt: { gte: startOfDay },
        status: { not: 'refunded' },
      },
    })
    if ((spent._sum.price ?? 0) + price >= dailyThreshold) return true
  }

  return false
}

/**
 * 下单前的二次验证裁决：服务端重算触发条件（绝不信任 preview 的
 * requiresVerification 声明），触发时比对登录密码。
 *
 * 必须在幂等 claim 之后、订单事务之前调用——bcrypt 慢操作不进 DB 事务；
 * 抛错走 createOrder 的 release 路径，同 key 可换密码重试同一意图。
 * 密码是凭证不是订单内容，不进幂等指纹（requestDigest）。
 */
export async function assertCheckoutVerification(
  userId: number,
  price: number,
  verificationPassword: string | undefined
) {
  const required = await resolveVerificationRequirement(userId, price)
  if (!required) return

  if (!verificationPassword) {
    throw new HttpError(401, 'VERIFICATION_REQUIRED', '本单需输入登录密码确认')
  }

  assertNotLocked(userId)

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { password: true },
  })
  if (!user) throw notFound('用户不存在')

  const valid = await bcrypt.compare(verificationPassword, user.password)
  if (!valid) {
    registerFailure(userId)
    // 错误信息不携带剩余尝试次数，避免为爆破提供进度反馈。
    throw new HttpError(401, 'VERIFICATION_FAILED', '密码错误，请重新输入')
  }

  failedAttempts.delete(userId)
}
