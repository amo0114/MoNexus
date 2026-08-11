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
})

let shuttingDown = false

async function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) return
  shuttingDown = true
  logger.info({ signal }, 'shutdown started')

  const forceExit = setTimeout(() => {
    logger.error({ signal }, 'shutdown timeout, exiting')
    process.exit(1)
  }, 10_000)
  forceExit.unref()

  server.close(async err => {
    if (err) logger.error({ err }, 'http server close failed')

    try {
      await quitRedis()
      clearCacheProcessState()
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
      await prisma.$disconnect()
      clearTimeout(forceExit)
      logger.info({ signal }, 'shutdown completed')
      process.exit(err ? 1 : 0)
    } catch (closeErr) {
      clearTimeout(forceExit)
      logger.error({ err: closeErr }, 'shutdown failed')
      process.exit(1)
    }
  })
}

process.on('SIGTERM', signal => void shutdown(signal))
process.on('SIGINT', signal => void shutdown(signal))
