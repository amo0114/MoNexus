import { defineLeasedCron } from '../../lib/leasedCron.js'
import { logger } from '../../lib/logger.js'
import { aggregateTraffic } from './service.js'

const cron = defineLeasedCron({
  name: 'traffic-aggregation',
  intervalMs: 60_000,
  async run() {
    const processed = await aggregateTraffic()
    logger.info({ processed }, 'traffic aggregation completed')
  },
})

export const startTrafficCron = cron.start
export const stopTrafficCron = cron.stop
