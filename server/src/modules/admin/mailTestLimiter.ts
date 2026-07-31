import type { Request, Response, NextFunction } from 'express'
import rateLimit from 'express-rate-limit'
import { config } from '../../config/index.js'
import { tooManyRequests } from '../../lib/httpError.js'
import { logger } from '../../lib/logger.js'
import { maskRecipientForAudit, writeMailTestAudit } from './mailOperations.js'
import crypto from 'crypto'

/** 每管理员每 10 分钟最多 3 次（规格 §4.4）。 */
export const ADMIN_MAIL_TEST_WINDOW_MS = 10 * 60 * 1000
export const ADMIN_MAIL_TEST_LIMIT = 3

/**
 * 测试邮件专用限流。
 *
 * 额度按**管理员**而不是 IP 计：办公室出口 NAT 后的多名管理员不该互相扣额度，
 * 而同一管理员换设备也不该重置额度。挂载位置在 MFA 鉴权之后、body 校验之前，
 * 因此每一次已认证 POST 都计数（含畸形请求、409 和发送失败）——否则失败重试
 * 就成了免费的外发放大器（C5）。
 *
 * 限制：`express-rate-limit` 默认 MemoryStore 是**进程内**的，多副本部署会把
 * 实际额度放大到 3×副本数。扩副本前必须换共享 store（发布检查项 R2）。
 *
 * `skipInTests` 做成参数而不是读全局：专项限流测试需要在 NODE_ENV=test 下
 * 真正跑限流逻辑，其余测试仍要走仓库既有的绕过约定（F8）。
 */
export function createAdminMailTestLimiter(options: { skipInTests: boolean }) {
  return rateLimit({
    windowMs: ADMIN_MAIL_TEST_WINDOW_MS,
    limit: ADMIN_MAIL_TEST_LIMIT,
    standardHeaders: true,
    legacyHeaders: false,
    skip: () => options.skipInTests && config.nodeEnv === 'test',
    keyGenerator: (req: Request) => `admin:${req.user?.userId ?? 'unknown'}`,
    handler: async (req: Request, _res: Response, next: NextFunction) => {
      const adminUserId = req.user?.userId
      if (typeof adminUserId === 'number') {
        try {
          await writeMailTestAudit({
            adminUserId,
            phase: 'rate_limited',
            // body 尚未经 schema 校验，可能是任意 JSON：脱敏函数负责兜底成
            // `[invalid]`，绝不把原文写进审计（C6）。
            recipientMasked: maskRecipientForAudit((req.body as { email?: unknown } | undefined)?.email),
            correlationId: crypto.randomUUID(),
          })
        } catch (err) {
          // 审计写失败绝不能翻转限流结论——放行才是更坏的失败模式。
          logger.error({ err }, 'failed to audit admin mail test rate limit rejection')
        }
      }
      next(tooManyRequests('测试邮件发送过于频繁，请稍后再试'))
    },
  })
}

/** 生产单例：沿用仓库约定，在 NODE_ENV=test 下绕过。 */
export const adminMailTestLimiter = createAdminMailTestLimiter({ skipInTests: true })
