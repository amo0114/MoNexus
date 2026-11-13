import { config } from '../../config/index.js'
import { prisma } from '../../lib/prisma.js'
import { logger } from '../../lib/logger.js'
import { acquireCronLeaseWithHeartbeat } from '../../lib/cronLease.js'
import { claimExport, executeExport, cleanupExports } from '../adminExports/service.js'
import { runIntegrityBatch } from '../wallet/integrity.js'
import { releaseExpiredBans } from '../accountGovernance/service.js'

let timer: NodeJS.Timeout | null = null
let pending: Promise<void> | null = null
export async function runGovernanceTick() {
  // Exports have their own lease/CAS, permitting two executors across replicas.
  for (let i = 0; i < 2; i++) {
    const job = await claimExport()
    if (!job) break
    await executeExport(job)
  }
  const lease = await acquireCronLeaseWithHeartbeat('governance-maintenance', 60000)
  if (!lease) return
  try {
    await releaseExpiredBans()
    await runIntegrityBatch()
    await cleanupExports()
  } catch (err) {
    await lease.releaseForRetry()
    throw err
  } finally {
    lease.release()
  }
}
export function startGovernanceWorker() {
  if (config.nodeEnv === 'test' || timer) return
  const tick = () => {
    if (!pending)
      pending = runGovernanceTick()
        .catch((err) => logger.error({ err }, 'governance worker failed'))
        .finally(() => {
          pending = null
        })
  }
  tick()
  timer = setInterval(tick, 15000)
  timer.unref()
}
export async function stopGovernanceWorker() {
  if (timer) clearInterval(timer)
  timer = null
  await pending
}
