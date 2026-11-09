import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import { BACKGROUND_ALERTS } from '../lib/backgroundAlerts.js'
import { lifecycleBacklog, lifecycleOldestAge, lifecycleEvents, refreshLifecycleMetrics } from '../modules/orders/metrics.js'
import { prisma } from '../lib/prisma.js'
import { createTestUser, createTestProduct } from './helpers.js'

it('R2-05: rules, deploy mounts and bounded-label metrics cover operational failure paths', async () => {
  const root = resolve('..')
  const rules = readFileSync(resolve(root, 'docs/operations/background-alerts.rules.yml'), 'utf8')
  const doc = readFileSync(resolve(root, 'docs/operations/background-alerts.md'), 'utf8')
  for (const alert of BACKGROUND_ALERTS) {
    expect(rules).toContain(alert.name); expect(rules).toContain(alert.expr)
    expect(doc).toContain(alert.routing)
    expect(alert.expr).not.toMatch(/orderId|userId|account/)
  }
  for (const file of ['docker-compose.prod.yml', 'deploy/vps/monexus-compose-deploy']) {
    expect(readFileSync(resolve(root, file), 'utf8')).toContain('background-alerts.rules.yml:/etc/prometheus/rules/background-alerts.rules.yml:ro')
  }
  const { user } = await createTestUser('r2-metrics@test.local', 'pass123', 'user')
  const product = await createTestProduct('metrics order', 100, 0, [])
  await prisma.order.create({ data: { userId: user.id, productId: product.id, price: 100, status: 'pending', cancelRequestedAt: new Date(Date.now() - 1800_000) } })
  const refunded = await prisma.order.create({ data: { userId: user.id, productId: product.id, price: 100, status: 'refunded' } })
  await prisma.fakaBridgeTask.create({ data: { orderId: refunded.id, status: 'succeeded', requestOrderNo: `MN-${refunded.id}`,
    emailSnapshot: user.email, skuSnapshot: 'test-only', revokeStatus: 'failed' } })
  await refreshLifecycleMetrics(true)
  expect((await lifecycleBacklog.get()).values).toContainEqual(expect.objectContaining({ labels: { state: 'cancel_pending' }, value: 1 }))
  expect((await lifecycleOldestAge.get()).values.find(row => row.labels.state === 'cancel_pending')!.value).toBeGreaterThanOrEqual(1800)
  expect((await lifecycleBacklog.get()).values).toContainEqual(expect.objectContaining({ labels: { state: 'faka_revoke_failed' }, value: 1 }))
  expect((await lifecycleEvents.get()).type).toBe('counter')
})
