import { app } from './app.js'
import { config } from './config/index.js'
import { clearCacheProcessState } from './lib/cache.js'
import { logger } from './lib/logger.js'
import { prisma } from './lib/prisma.js'
import { quitRedis } from './lib/redis.js'
import { startOrderCron, stopOrderCron } from './modules/orders/cron.js'
import { startFileCleanupCron, stopFileCleanupCron } from './lib/fileCleanup.js'
import { startLowStockNotifyCron, stopLowStockNotifyCron } from './lib/lowStockNotify.js'
import { startSubscriptionRemindCron, stopSubscriptionRemindCron } from './lib/subscriptionRemind.js'
import { startSlaRemindCron, stopSlaRemindCron } from './lib/slaRemind.js'
import { startBookingRemindCron, stopBookingRemindCron } from './lib/bookingRemind.js'
import { startProvisionCron, stopProvisionCron } from './modules/orders/provisionCron.js'
import { startFakaBridgeCron, stopFakaBridgeCron } from './lib/fakaBridge/index.js'
import { startGrowthRewardCron, stopGrowthRewardCron } from './modules/auth/growthRewardCron.js'
import { startLeaderboardCron, stopLeaderboardCron } from './modules/leaderboard/cron.js'
import { startLegalRetentionCron, stopLegalRetentionCron } from './modules/legal/cron.js'
import { startRankingCron, stopRankingCron } from './modules/merchandising/ranking/index.js'
import { startCampaignLifecycleCron, stopCampaignLifecycleCron } from './modules/merchandising/promotions/lifecycle.js'
import { startEditorialLifecycleCron, stopEditorialLifecycleCron } from './modules/merchandising/editorial/cron.js'
import { startPartnerEntitlementCron, stopPartnerEntitlementCron } from './modules/merchandising/entitlements/cron.js'
import { getNotificationRealtimeHub } from './modules/notifications/realtime/hub.js'
import { getNotificationRealtimeLifecycle } from './modules/notifications/realtime/lifecycle.js'

const server = app.listen(config.port, () => {
  logger.info(`MoNexus API running at http://localhost:${config.port}`)
  startOrderCron()
  startFileCleanupCron()
  startLowStockNotifyCron()
  startSubscriptionRemindCron()
  startSlaRemindCron()
  startBookingRemindCron()
  startProvisionCron()
  startFakaBridgeCron()
  startGrowthRewardCron()
  startLeaderboardCron()
  startLegalRetentionCron()
  startRankingCron()
  startCampaignLifecycleCron()
  startEditorialLifecycleCron()
  startPartnerEntitlementCron()
  if (config.notificationRealtime.enabled) {
    // Start the dedicated LISTEN listener once realtime is enabled.
    void getNotificationRealtimeLifecycle().start()
  }
})

let shuttingDown = false
let forceExitTimer: NodeJS.Timeout | null = null

async function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) return
  shuttingDown = true
  logger.info({ signal }, 'shutdown started')

  const lifecycle = getNotificationRealtimeLifecycle()
  const hub = getNotificationRealtimeHub()
  const graceMs = config.notificationRealtime.shutdownGraceMs

  // 1. 10s force-exit timer + draining CAS. Repeated signals only log (idempotent).
  forceExitTimer = setTimeout(() => {
    logger.error({ signal }, 'shutdown timeout, exiting')
    process.exit(1)
  }, 10_000)
  forceExitTimer.unref()
  lifecycle.beginDraining()

  // 2. Stop accepting new TCP/HTTP immediately; keep the completion promise.
  const serverClosePromise = new Promise<void>(resolve => {
    server.close(err => {
      if (err) logger.error({ err }, 'http server close failed')
      resolve()
    })
  })

  // 3. Synchronously stop all cron / background producers (no new business writes).
  stopOrderCron()
  stopFileCleanupCron()
  stopLowStockNotifyCron()
  stopSubscriptionRemindCron()
  stopSlaRemindCron()
  stopBookingRemindCron()
  stopProvisionCron()
  stopFakaBridgeCron()
  stopGrowthRewardCron()
  stopLeaderboardCron()
  stopLegalRetentionCron()
  stopRankingCron()
  stopCampaignLifecycleCron()
  stopEditorialLifecycleCron()
  stopPartnerEntitlementCron()

  // 4. Drain SSE within the configured grace, then force-destroy leftovers.
  const drainPromise = (async () => {
    await hub.degradeAndDrain('server_shutdown', graceMs)
    await new Promise<void>(resolve => {
      const t = setTimeout(resolve, graceMs)
      t.unref?.()
    })
    await hub.closeAll()
  })()

  // 5. Stop the listener: clear probe / retry / generation timers and close client.
  const listenerStopPromise = lifecycle.stop()

  try {
    // 6. Wait for in-flight HTTP handlers to finish, then quit Redis / Prisma.
    await serverClosePromise
    await listenerStopPromise
    await drainPromise
    await quitRedis()
    clearCacheProcessState()
    await prisma.$disconnect()
    if (forceExitTimer) clearTimeout(forceExitTimer)
    logger.info({ signal }, 'shutdown completed')
    process.exit(0)
  } catch (closeErr) {
    if (forceExitTimer) clearTimeout(forceExitTimer)
    logger.error({ err: closeErr }, 'shutdown failed')
    process.exit(1)
  }
}

process.on('SIGTERM', signal => void shutdown(signal))
process.on('SIGINT', signal => void shutdown(signal))
