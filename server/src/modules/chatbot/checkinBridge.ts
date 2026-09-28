import { checkin, type CheckinSource } from '../points/service.js'

/**
 * SPEC-CHAT-BOT-001 — 机器人签到桥接。
 *
 * 网页端「今日已签到」是 400 错误，适合前端弹 toast。但机器人场景里，
 * 用户重复发「签到」是高频且无害的操作，把它变成错误会让机器人回一堆
 * 异常文案，体验很差。这里把该特定错误翻译成结构化结果，让插件能回
 * 「今天已经签过啦，明天再来」这种正常语气。
 *
 * 只吞掉「今日已签到」这一种冲突，其余错误（账户不存在、数据库故障）
 * 一律继续抛出，避免把真实故障伪装成成功。
 */
export interface BotCheckinResult {
  ok: boolean
  alreadyCheckedIn: boolean
  totalReward: number
  baseReward: number
  bonusReward: number
  tier: string
  balanceAfter: number
}

export async function checkinForBot(
  userId: number,
  source: CheckinSource = 'qq'
): Promise<BotCheckinResult> {
  try {
    const r = await checkin(userId, source)
    return {
      ok: true,
      alreadyCheckedIn: false,
      totalReward: r.totalReward,
      baseReward: r.baseReward,
      bonusReward: r.bonusReward,
      tier: r.tier,
      balanceAfter: r.balanceAfter,
    }
  } catch (error) {
    if (isAlreadyCheckedInError(error)) {
      return {
        ok: true,
        alreadyCheckedIn: true,
        totalReward: 0,
        baseReward: 0,
        bonusReward: 0,
        tier: '',
        balanceAfter: 0,
      }
    }
    throw error
  }
}

/**
 * points.service.checkin 在唯一约束冲突时抛 badRequest('今日已签到')。
 * 这里按 HTTP 状态 + 文案双重判定，而不是只看 message 子串——避免将来
 * 文案改动导致静默失效，也避免误吞其它 400。
 */
function isAlreadyCheckedInError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const e = error as { status?: number; statusCode?: number; message?: string }
  const status = e.status ?? e.statusCode
  return status === 400 && typeof e.message === 'string' && e.message.includes('今日已签到')
}
