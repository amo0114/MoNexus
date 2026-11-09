import { businessDateString } from './businessTime.js'
import { logger } from './logger.js'
import { prisma } from './prisma.js'

/**
 * SPEC-ENGAGE-001 §2.4：记录「登录用户 × 上海自然日」。挂在 authenticate
 * 热路径上，所以进程内去重（每进程每用户每天最多写一次），写库
 * fire-and-forget，失败只记日志——绝不阻塞或拖慢请求。
 */
const recorded = new Map<number, string>()

export function recordActiveDay(userId: number, now = new Date()) {
  const day = businessDateString(now)
  if (recorded.get(userId) === day) return
  recorded.set(userId, day)
  prisma.$executeRaw`
    INSERT INTO "UserActiveDay" ("userId", "day") VALUES (${userId}, ${day})
    ON CONFLICT DO NOTHING`
    .catch(err => {
      recorded.delete(userId)
      logger.warn({ err, userId }, 'record active day failed')
    })
}

export function __resetActiveDayMemoForTests() {
  recorded.clear()
}
