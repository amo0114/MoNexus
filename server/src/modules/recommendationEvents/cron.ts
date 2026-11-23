import { defineLeasedCron } from '../../lib/leasedCron.js'
import { logger } from '../../lib/logger.js'
import { cleanupRecommendationEvents } from './service.js'

const cron = defineLeasedCron({
  name: 'recommendation-event-retention',
  intervalMs: 60_000,
  async run() {
    await cleanupRecommendationEvents()
    logger.debug('recommendation event retention completed')
  },
})

export const startRecommendationEventsCron = cron.start
export const stopRecommendationEventsCron = cron.stop
