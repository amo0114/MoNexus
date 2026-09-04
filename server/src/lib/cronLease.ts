import { hostname } from 'node:os'
import { randomUUID } from 'node:crypto'
import { config } from '../config/index.js'
import { logger } from './logger.js'
import { prisma } from './prisma.js'

/**
 * P7a：cron 舰队租约（设计 §2.1；PR #52 复审 P1 修订：调度周期与租约解耦）。
 *
 * 两个正交机制（P1 教训：单一 lockedUntil = now()+周期 且不释放，会与
 * 「立即首跑 + setInterval(周期)」的节拍差出 ε 毫秒——下一 tick 比过期
 * 早到而被跳过，实际退化为每两周期执行一次）：
 *
 * - **运行互斥**（lockedUntil）：固定短 TTL（90s，与周期无关）+ 心跳
 *   （30s，三拍全丢才失去互斥）维持；批次结束在 finally 里**立即释放**
 *   （lockedUntil = now()）；实例崩溃后 ≤ 90s 自然过期。
 * - **窗口节流**（lastStartedAt）：距上次启动不足 window 的领取一律拒绝；
 *   window = 周期 − margin（margin = clamp(周期/20, 5s, 60s)）**严格短于
 *   调度周期**——正常短批次在下一个 tick 必然重新可领，按配置周期运行；
 *   margin 吸收「timer 创建 → 首跑领取」的 ε 延迟与时钟毫厘。窗口锚定
 *   批次**开始**时刻，中等长度批次不推迟下一周期。
 *
 * 其余硬规则不变：
 * - 时间判定全部用 DB now()——实例时钟漂移不参与任何比较。
 * - 领取是单条原子 upsert：ON CONFLICT 分支在行锁下按最新行版本重评
 *   WHERE，并发领取者恰有一个拿到 RETURNING 行。
 * - 续租/释放都要 leaseToken 匹配，过期持有者动不到新租约。
 * - 互斥丢失只告警不中断：全部 cron 已有状态表去重/CAS，重复执行是噪音
 *   不是数据损坏，中途放弃反而留下半途状态。
 * - test 环境 acquireCronLeaseWithHeartbeat 直通（不触表），既有直调
 *   runXxxBatch 的测试不受影响；租约自身的测试用 force 走真实路径。
 *
 * 崩溃空窗上界：互斥 ≤ 90s 过期，窗口按 lastStartedAt 节流到窗口末端，
 * 接管发生在其后第一个 tick——同名 job 最大空窗仍 < 2×周期。
 */

const HOLDER = `${hostname()}:${process.pid}`

// 运行互斥参数与调度周期无关（解耦核心）：90s TTL、30s 心跳。
const MUTEX_TTL_MS = 90_000
const HEARTBEAT_INTERVAL_MS = 30_000

/** 节流窗口 = 周期 − margin，**严格短于周期**（P1 修复核心）；margin 夹在 5s–60s。 */
export function cronLeaseWindowMs(periodMs: number): number {
  const margin = Math.min(60_000, Math.max(5_000, Math.floor(periodMs / 20)))
  return Math.max(Math.floor(periodMs / 2), periodMs - margin)
}

/** 领取租约：领到返回本次 leaseToken；互斥被持有或距上次启动不足窗口则返回 null。 */
export async function tryAcquireCronLease(name: string, periodMs: number): Promise<string | null> {
  const token = randomUUID()
  const rows = await prisma.$queryRaw<Array<{ name: string }>>`
    INSERT INTO "CronLease" ("name", "holder", "leaseToken", "lockedUntil", "lastStartedAt", "updatedAt")
    VALUES (${name}, ${HOLDER}, ${token}, now() + make_interval(secs => ${MUTEX_TTL_MS / 1000}), now(), now())
    ON CONFLICT ("name") DO UPDATE
      SET "holder" = EXCLUDED."holder",
          "leaseToken" = EXCLUDED."leaseToken",
          "lockedUntil" = EXCLUDED."lockedUntil",
          "lastStartedAt" = EXCLUDED."lastStartedAt",
          "updatedAt" = now()
      WHERE "CronLease"."lockedUntil" <= now()
        AND "CronLease"."lastStartedAt" <= now() - make_interval(secs => ${cronLeaseWindowMs(periodMs) / 1000})
    RETURNING "name"`
  return rows.length > 0 ? token : null
}

/** 续互斥：仅当租约仍属于该 token 时把 lockedUntil 推至 now()+90s。 */
export async function renewCronLease(name: string, token: string): Promise<boolean> {
  const updated = await prisma.$executeRaw`
    UPDATE "CronLease"
    SET "lockedUntil" = now() + make_interval(secs => ${MUTEX_TTL_MS / 1000}), "updatedAt" = now()
    WHERE "name" = ${name} AND "leaseToken" = ${token}`
  return updated > 0
}

/** 释放互斥（批次结束）：lockedUntil 即刻归零；lastStartedAt 保留供窗口节流。 */
export async function releaseCronLease(name: string, token: string): Promise<boolean> {
  const updated = await prisma.$executeRaw`
    UPDATE "CronLease"
    SET "lockedUntil" = now(), "updatedAt" = now()
    WHERE "name" = ${name} AND "leaseToken" = ${token}`
  return updated > 0
}

/**
 * 失败回拨：仅凭当前 leaseToken 释放互斥，并把 lastStartedAt 回拨一个完整
 * 节流窗口——失败批次不消耗窗口，下一 tick 即可重新领取（各 job 靠状态表
 * 幂等保证重算无害）。token 不匹配（互斥 TTL 过期后被其他实例接管）时
 * 0 行命中，新持有者的租约与窗口不受任何影响。
 */
export async function rollbackCronLeaseForRetry(
  name: string,
  token: string,
  periodMs: number
): Promise<boolean> {
  const updated = await prisma.$executeRaw`
    UPDATE "CronLease"
    SET "lockedUntil" = now(),
        "lastStartedAt" = now() - make_interval(secs => ${cronLeaseWindowMs(periodMs) / 1000}),
        "updatedAt" = now()
    WHERE "name" = ${name} AND "leaseToken" = ${token}`
  return updated > 0
}

export interface CronLeaseHandle {
  /** 批次结束时调用（finally）：停心跳并释放互斥。窗口节流不受影响。 */
  release(): void
  /**
   * 批次失败时调用（可等待）：停心跳、释放互斥并回拨本次节流窗口，使下一
   * tick 可立即重试。普通 release() 行为保持不变。
   */
  releaseForRetry(): Promise<void>
}

const NOOP_HANDLE: CronLeaseHandle = {
  release() {},
  async releaseForRetry() {},
}

/**
 * 领取租约并启动心跳。返回 null = 本窗口已有实例启动过（或互斥被持有），
 * 调用方直接跳过本 tick。
 */
export async function acquireCronLeaseWithHeartbeat(
  name: string,
  periodMs: number,
  opts?: { force?: boolean }
): Promise<CronLeaseHandle | null> {
  if (config.nodeEnv === 'test' && !opts?.force) return NOOP_HANDLE

  const token = await tryAcquireCronLease(name, periodMs)
  if (!token) {
    logger.debug({ name }, 'cron lease window/mutex held, skipping tick')
    return null
  }
  const heartbeat = setInterval(() => {
    renewCronLease(name, token)
      .then(renewed => {
        if (!renewed) {
          logger.warn({ name }, 'cron lease lost mid-batch; continuing — state tables keep re-runs safe')
        }
      })
      .catch(err => logger.warn({ err, name }, 'cron lease renew failed'))
  }, HEARTBEAT_INTERVAL_MS)
  heartbeat.unref?.()
  return {
    release() {
      clearInterval(heartbeat)
      // 尽力释放：失败无碍（互斥 ≤ 90s 自然过期），不阻塞批次收尾。
      releaseCronLease(name, token).catch(err => logger.warn({ err, name }, 'cron lease release failed'))
    },
    async releaseForRetry() {
      clearInterval(heartbeat)
      const rolled = await rollbackCronLeaseForRetry(name, token, periodMs).catch(err => {
        logger.warn({ err, name }, 'cron lease retry rollback failed')
        return false
      })
      if (!rolled) {
        // 0 行 = token 已易主或早已释放：新持有者的窗口绝不能被动。
        logger.debug({ name }, 'cron lease retry rollback matched no row')
      }
    },
  }
}
