import { config } from '../../../config/index.js'
import { acquireCronLeaseWithHeartbeat } from '../../../lib/cronLease.js'
import { logger } from '../../../lib/logger.js'
import { reconcilePartnerEntitlements, type PartnerEntitlementJobResult } from './service.js'

export const PARTNER_ENTITLEMENT_CRON_TICK_MS = 3_600_000
const PARTNER_ENTITLEMENT_CRON_NAME = 'merchandising-partner-entitlements'

let timer: NodeJS.Timeout | null = null
let running = false

export async function runPartnerEntitlementBatch(): Promise<PartnerEntitlementJobResult | null> {
  if (running) return null
  running = true
  let lease: Awaited<ReturnType<typeof acquireCronLeaseWithHeartbeat>> = null
  try {
    lease = await acquireCronLeaseWithHeartbeat(PARTNER_ENTITLEMENT_CRON_NAME, PARTNER_ENTITLEMENT_CRON_TICK_MS)
    if (!lease) return null
    const result = await reconcilePartnerEntitlements()
    logger.info({ ...result }, 'partner entitlement reconciliation completed')
    return result
  } catch (err) {
    logger.error({ err }, 'partner entitlement reconciliation failed')
    return null
  } finally {
    lease?.release()
    running = false
  }
}

export function startPartnerEntitlementCron(): void {
  if (config.nodeEnv === 'test' || timer) return
  runPartnerEntitlementBatch().catch(err => logger.error({ err }, 'partner entitlement initial tick failed'))
  timer = setInterval(() => {
    runPartnerEntitlementBatch().catch(err => logger.error({ err }, 'partner entitlement tick failed'))
  }, PARTNER_ENTITLEMENT_CRON_TICK_MS)
  timer.unref?.()
  logger.info({ tickMs: PARTNER_ENTITLEMENT_CRON_TICK_MS }, 'partner entitlement cron started')
}

export function stopPartnerEntitlementCron(): void {
  if (!timer) return
  clearInterval(timer)
  timer = null
  logger.info('partner entitlement cron stopped')
}
