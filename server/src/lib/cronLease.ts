import { hostname } from 'node:os'
import { randomUUID } from 'node:crypto'
import { config } from '../config/index.js'
import { logger } from './logger.js'
import { prisma } from './prisma.js'

/**
 * P7a：cron 舰队租约（设计 §2.1）。多实例部署下，同名 job 在任一时刻至多
 * 一个实例执行（运行期互斥），且舰队级至多每 TTL 窗口启动一次（窗口节流）。
 *
 * 硬规则：
 * - 时间判定全部用 DB now()——实例时钟漂移不参与任何比较。
 * - 领取是单条原子 upsert：ON CONFLICT 分支在行锁下按最新行版本重评 WHERE，
 *   并发领取者恰有一个拿到 RETURNING 行。
 * - 运行期互斥由**心跳续租**维持（每 TTL/4 把 lockedUntil 推至 now()+TTL，
 *   仅当 leaseToken 仍是自己的）：批次超过 TTL 时互斥仍成立。无续租的
 *   "TTL = 周期"只能称尽力去重，不能称 at-most-once（P7 评审点 5）。
 * - 批次结束**不主动释放**：释放会让同窗口的另一实例立即重跑，违背节流
 *   意图。租约存续至最后一次续期 + TTL；实例崩溃后自然过期（≤ TTL），
 *   同名 job 最大空窗 < 2×周期。
 * - 续租失败（租约被抢——仅在心跳整段丢失后可能）只告警不中断：全部
 *   cron 已有状态表去重/CAS，重复执行是噪音不是数据损坏，中途放弃反而
 *   留下半途状态。
 * - test 环境 acquireCronLeaseWithHeartbeat 直通（不触表），既有直调
 *   runXxxBatch 的测试不受影响；租约自身的测试用 force 走真实路径。
 */

const HOLDER = `${hostname()}:${process.pid}`

/** 领取租约：领到返回本次 leaseToken，他人持有未过期则返回 null。 */
export async function tryAcquireCronLease(name: string, ttlMs: number): Promise<string | null> {
  const token = randomUUID()
  const rows = await prisma.$queryRaw<Array<{ name: string }>>`
    INSERT INTO "CronLease" ("name", "holder", "leaseToken", "lockedUntil", "updatedAt")
    VALUES (${name}, ${HOLDER}, ${token}, now() + make_interval(secs => ${ttlMs / 1000}), now())
    ON CONFLICT ("name") DO UPDATE
      SET "holder" = EXCLUDED."holder",
          "leaseToken" = EXCLUDED."leaseToken",
          "lockedUntil" = EXCLUDED."lockedUntil",
          "updatedAt" = now()
      WHERE "CronLease"."lockedUntil" <= now()
    RETURNING "name"`
  return rows.length > 0 ? token : null
}

/** 续租：仅当租约仍属于该 token 时把 lockedUntil 推至 now()+TTL。 */
export async function renewCronLease(name: string, token: string, ttlMs: number): Promise<boolean> {
  const updated = await prisma.$executeRaw`
    UPDATE "CronLease"
    SET "lockedUntil" = now() + make_interval(secs => ${ttlMs / 1000}), "updatedAt" = now()
    WHERE "name" = ${name} AND "leaseToken" = ${token}`
  return updated > 0
}

export interface CronLeaseHandle {
  /** 批次结束时停掉心跳（finally 中调用）。不释放租约本身——窗口节流语义。 */
  stopHeartbeat(): void
}

const NOOP_HANDLE: CronLeaseHandle = { stopHeartbeat() {} }

/**
 * 领取租约并启动心跳。返回 null = 本窗口已有实例执行，调用方直接跳过本 tick。
 * 心跳周期 = max(TTL/4, 15s)：短批次通常一次都不触发；超长批次靠它维持互斥。
 */
export async function acquireCronLeaseWithHeartbeat(
  name: string,
  ttlMs: number,
  opts?: { force?: boolean }
): Promise<CronLeaseHandle | null> {
  if (config.nodeEnv === 'test' && !opts?.force) return NOOP_HANDLE

  const token = await tryAcquireCronLease(name, ttlMs)
  if (!token) {
    logger.debug({ name }, 'cron lease held elsewhere, skipping tick')
    return null
  }
  const heartbeat = setInterval(() => {
    renewCronLease(name, token, ttlMs)
      .then(renewed => {
        if (!renewed) {
          logger.warn({ name }, 'cron lease lost mid-batch; continuing — state tables keep re-runs safe')
        }
      })
      .catch(err => logger.warn({ err, name }, 'cron lease renew failed'))
  }, Math.max(Math.floor(ttlMs / 4), 15_000))
  heartbeat.unref?.()
  return {
    stopHeartbeat() {
      clearInterval(heartbeat)
    },
  }
}
