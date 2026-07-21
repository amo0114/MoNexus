import { app } from './app.js'
import { config } from './config/index.js'
import { clearCacheProcessState } from './lib/cache.js'
import { logger } from './lib/logger.js'
import { prisma } from './lib/prisma.js'
import { quitRedis } from './lib/redis.js'

const server = app.listen(config.port, () => {
  logger.info(`MoNexus API running at http://localhost:${config.port}`)
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
