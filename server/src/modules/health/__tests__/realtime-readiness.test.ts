import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checkReadiness } from '../service.js'
import { config } from '../../../config/index.js'
import { getNotificationRealtimeLifecycle } from '../../notifications/realtime/lifecycle.js'

/**
 * SPEC-NOTIFY-RT-001 T-BE-005 — readiness includes the realtime listener state
 * (spec 8.3 / CHK-OPS-001~002): disabled/ok/degraded never flip core readiness;
 * draining must return unready (503).
 */
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

describe('readiness notificationRealtime check (spec 8.3 / CHK-OPS-001~002)', () => {
  const prevNotification = config.notification.enabled
  const prevRealtime = config.notificationRealtime.enabled

  beforeEach(() => {
    config.notification.enabled = true
    config.notificationRealtime.enabled = true
  })

  afterEach(async () => {
    config.notification.enabled = prevNotification
    config.notificationRealtime.enabled = prevRealtime
    await getNotificationRealtimeLifecycle().stop()
  })

  it('reports disabled when realtime is off (overall ready)', async () => {
    config.notificationRealtime.enabled = false
    const result = await checkReadiness()
    expect(result.checks.notificationRealtime).toBe('disabled')
    expect(result.status).toBe('ready')
  })

  it('reports ok when the listener is healthy (overall ready)', async () => {
    const lifecycle = getNotificationRealtimeLifecycle()
    await lifecycle.start()
    const deadline = Date.now() + 8000
    while (Date.now() < deadline && lifecycle.getStatus() !== 'healthy') await sleep(100)
    const result = await checkReadiness()
    expect(result.checks.notificationRealtime).toBe('ok')
    expect(result.status).toBe('ready')
  })

  it('reports degraded after listener stop but core stays ready', async () => {
    const lifecycle = getNotificationRealtimeLifecycle()
    await lifecycle.start()
    const deadline = Date.now() + 8000
    while (Date.now() < deadline && lifecycle.getStatus() !== 'healthy') await sleep(100)
    await lifecycle.stop()
    const result = await checkReadiness()
    expect(result.checks.notificationRealtime).toBe('degraded')
    // Degraded must NOT make the core unready (CHK-OPS-002).
    expect(result.status).toBe('ready')
  })

  it('draining flips readiness to unready (CHK-OPS-002)', async () => {
    const lifecycle = getNotificationRealtimeLifecycle()
    await lifecycle.start()
    const deadline = Date.now() + 8000
    while (Date.now() < deadline && lifecycle.getStatus() !== 'healthy') await sleep(100)
    lifecycle.beginDraining()
    const result = await checkReadiness()
    expect(result.checks.notificationRealtime).toBe('draining')
    expect(result.status).toBe('unready')
  })
})
