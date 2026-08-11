import { config } from '../../config/index.js'
import { prisma } from '../../lib/prisma.js'
import { pingRedis, type RedisHealthStatus } from '../../lib/redis.js'
import { getNotificationRealtimeLifecycle } from '../notifications/realtime/lifecycle.js'

const DB_PING_TIMEOUT_MS = 2_000

export type LivenessResult = {
  status: 'live'
  uptime: number
  timestamp: string
}

export type ReadinessResult = {
  status: 'ready' | 'unready'
  checks: {
    database: 'ok' | 'fail'
    config: 'ok' | 'fail'
    redis: RedisHealthStatus
    notificationRealtime: 'disabled' | 'ok' | 'degraded' | 'draining'
  }
  timestamp: string
  error?: string
}

export function checkLiveness(): LivenessResult {
  return {
    status: 'live',
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  }
}

async function pingDatabase() {
  let timeout: ReturnType<typeof setTimeout> | undefined

  try {
    await Promise.race([
      prisma.$queryRaw`SELECT 1`,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('db ping timeout')), DB_PING_TIMEOUT_MS)
      }),
    ])
  } finally {
    if (timeout) {
      clearTimeout(timeout)
    }
  }
}

export async function checkReadiness(): Promise<ReadinessResult> {
  const checks: ReadinessResult['checks'] = { database: 'fail', config: 'fail', redis: 'disabled', notificationRealtime: 'disabled' }
  let error: string | undefined

  try {
    if (config.jwtSecret && config.databaseUrl) {
      checks.config = 'ok'
    }
  } catch (e) {
    error = `config: ${(e as Error).message}`
  }

  try {
    await pingDatabase()
    checks.database = 'ok'
  } catch (e) {
    error = `${error ? `${error}; ` : ''}database: ${(e as Error).message}`
  }
  checks.redis = await pingRedis()
  if (checks.redis === 'degraded' && config.redisRequired) {
    error = `${error ? `${error}; ` : ''}redis: degraded`
  }

  // SPEC-NOTIFY-RT-001 (spec 8.3): realtime listener state is observable; only
  // `draining` flips overall readiness to unready (degraded never does).
  const realtimeStatus = getNotificationRealtimeLifecycle().getStatus()
  if (config.notificationRealtime.enabled) {
    if (realtimeStatus === 'draining') checks.notificationRealtime = 'draining'
    else if (realtimeStatus === 'healthy') checks.notificationRealtime = 'ok'
    else if (realtimeStatus === 'disabled') checks.notificationRealtime = 'disabled'
    else checks.notificationRealtime = 'degraded'
  }

  const allOk =
    checks.database === 'ok' &&
    checks.config === 'ok' &&
    (!config.redisRequired || checks.redis === 'ok') &&
    checks.notificationRealtime !== 'draining'

  return {
    status: allOk ? 'ready' : 'unready',
    checks,
    timestamp: new Date().toISOString(),
    ...(error ? { error } : {}),
  }
}
