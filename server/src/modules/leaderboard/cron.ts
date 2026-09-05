import { config } from '../../config/index.js'
import { acquireCronLeaseWithHeartbeat, type CronLeaseHandle } from '../../lib/cronLease.js'
import { logger } from '../../lib/logger.js'
import { refreshLeaderboards } from './service.js'

/**
 * LB-09：排行榜每日刷新。60s tick + 24h 租约窗口 = 全舰队每日至多成功一轮，
 * 与其余 daily 任务同语义。
 *
 * 不做「定点 00:05」对时：cutoff 由 businessDateString(now) 推导（LB-03），
 * 与批次实际运行时刻无关；同日重复执行也只是重算同一窗口，由 LB-08 的
 * 事务替换兜底无害——因此批次失败时经 releaseForRetry 回拨窗口后，同日
 * 重试是安全的（不会出现「失败后 24h 不能重跑」的空窗）。
 */
export const LEADERBOARD_CRON_INTERVAL_MS = 60_000
export const LEADERBOARD_REFRESH_WINDOW_MS = 24 * 60 * 60 * 1_000

let timer: NodeJS.Timeout | null = null
let running = false

export async function runLeaderboardRefreshCronBatch() {
  if (running) return []
  running = true
  let lease: CronLeaseHandle | null = null
  try {
    lease = await acquireCronLeaseWithHeartbeat('leaderboard-refresh', LEADERBOARD_REFRESH_WINDOW_MS)
    if (!lease) return []

    return await refreshLeaderboards()
  } catch (err) {
    // 每期替换各自成事务；catch 到这里时失败那期已整体回滚，旧快照完好。
    // 失败批次不消耗 24h 节流窗口：回拨 lastStartedAt，下一个 60s tick 即可
    // 重试（LB-08 幂等保证重算无害）——否则一次瞬时 DB 抖动会让榜单落后一
    // 整天，且若落在周期切换日会放大成上一期快照的永久缺口。
    logger.error({ err }, 'leaderboard refresh cron batch failed')
    if (lease) {
      await lease.releaseForRetry()
      lease = null
    }
    return []
  } finally {
    lease?.release()
    running = false
  }
}

export function startLeaderboardCron() {
  if (config.nodeEnv === 'test') return
  if (timer) return

  runLeaderboardRefreshCronBatch().catch(err => {
    logger.error({ err }, 'leaderboard cron initial tick failed')
  })
  timer = setInterval(() => {
    runLeaderboardRefreshCronBatch().catch(err => {
      logger.error({ err }, 'leaderboard cron tick failed')
    })
  }, LEADERBOARD_CRON_INTERVAL_MS)
  timer.unref?.()
  logger.info({ intervalMs: LEADERBOARD_CRON_INTERVAL_MS }, 'leaderboard cron started')
}

export function stopLeaderboardCron() {
  if (!timer) return
  clearInterval(timer)
  timer = null
  logger.info('leaderboard cron stopped')
}

export async function __runLeaderboardRefreshForTests() {
  return runLeaderboardRefreshCronBatch()
}
