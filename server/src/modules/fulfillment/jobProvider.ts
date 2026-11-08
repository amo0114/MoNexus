import { randomUUID } from 'node:crypto'
import type { FulfillmentJob, Prisma } from '@prisma/client'
import type {
  ExternalFulfillmentAdapter,
  FulfillmentCommand,
  FulfillmentProvider,
  RemoteObservation,
} from '../../extension-contracts/fulfillment.js'
import { config } from '../../config/index.js'
import { badRequest, HttpError } from '../../lib/httpError.js'
import { logger } from '../../lib/logger.js'
import { prisma } from '../../lib/prisma.js'
import { deliverExternalResultInTx, refundUndeliveredExternalOrderInTx } from './apply.js'

type Tx = Prisma.TransactionClient

/**
 * Core fulfillment engine for providers that implement only
 * `ExternalFulfillmentAdapter`. One FulfillmentJob per order, created in the
 * order transaction. Workers claim a row lease (Order → Job lock order), call
 * the adapter outside any transaction, then apply the observation under the
 * Order lock with a lease-token CAS. Work is distributed by row claims, so the
 * tick does not take a CronLease (same as the merchant provision cron).
 */

const LEASE_MS = 60_000
const RETRY_DELAYS_MS = [30_000, 120_000, 600_000]
const RECONCILE_COOLDOWN_MS = 5 * 60_000
const DEFAULT_MAX_ATTEMPTS = 3
const BATCH_LIMIT = 20
const INTERVAL_MS = 30_000

const adapters = new Map<string, ExternalFulfillmentAdapter>()

function retryDelayMs(attempts: number): number {
  return RETRY_DELAYS_MS[Math.min(Math.max(attempts, 1), RETRY_DELAYS_MS.length) - 1]
}

function commandOf(job: FulfillmentJob): FulfillmentCommand {
  return {
    providerId: job.providerId,
    operationKey: job.operationKey,
    orderId: job.orderId,
    sku: job.skuSnapshot,
    input: (job.inputSnapshot as Record<string, unknown> | null) ?? {},
  }
}

type Claimed = FulfillmentJob & { leaseToken: string; mode: 'execute' | 'query' | 'cancel' }

async function claimJob(jobId: number): Promise<Claimed | null> {
  return prisma.$transaction(async tx => {
    const peek = await tx.fulfillmentJob.findUnique({ where: { id: jobId }, select: { orderId: true } })
    if (!peek) return null
    await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${peek.orderId} FOR UPDATE`
    const job = await tx.fulfillmentJob.findUnique({ where: { id: jobId } })
    const now = new Date()
    if (!job || (job.status !== 'pending' && job.status !== 'needs_reconcile')) return null
    if (job.nextAttemptAt > now || (job.leaseUntil && job.leaseUntil > now)) return null
    const adapter = adapters.get(job.providerId)
    if (!adapter) return null

    const order = await tx.order.findUniqueOrThrow({ where: { id: job.orderId }, select: { status: true } })
    const orderTerminal = order.status === 'refunded' || order.status === 'closed'
    if (job.status === 'pending' && (orderTerminal || job.cancelRequested)) {
      // Never dispatched → nothing remote can exist. Otherwise converge by query/cancel.
      await tx.fulfillmentJob.update({
        where: { id: job.id },
        data: job.attempts === 0
          ? { status: 'cancelled', cancelRequested: true, completedAt: now, note: 'cancelled before first dispatch' }
          : { status: 'needs_reconcile', cancelRequested: true, nextAttemptAt: now },
      })
      if (job.attempts === 0) return null
      job.status = 'needs_reconcile'
      job.cancelRequested = true
    }

    const mode = job.status === 'pending' ? 'execute' : job.cancelRequested && adapter.cancel ? 'cancel' : 'query'
    const attempts = mode === 'execute' ? job.attempts + 1 : job.attempts
    const leaseToken = randomUUID()
    await tx.fulfillmentJob.update({
      where: { id: job.id },
      data: {
        attempts,
        leaseToken,
        leaseUntil: new Date(now.getTime() + LEASE_MS),
        // Pre-write the backoff so a crash mid-call cannot tight-loop.
        nextAttemptAt: new Date(now.getTime() + (mode === 'execute' ? retryDelayMs(attempts) : RECONCILE_COOLDOWN_MS)),
      },
    })
    return { ...job, attempts, leaseToken, mode }
  })
}

async function observe(adapter: ExternalFulfillmentAdapter, claimed: Claimed): Promise<RemoteObservation> {
  const command = commandOf(claimed)
  try {
    if (claimed.mode === 'execute') return await adapter.execute(command)
    if (claimed.mode === 'cancel') return await adapter.cancel!(command)
    return await adapter.query(command)
  } catch (err) {
    logger.warn({ err, jobId: claimed.id, providerId: claimed.providerId }, 'fulfillment adapter call failed')
    return { kind: 'unknown', code: 'ADAPTER_EXCEPTION' }
  }
}

async function applyObservation(claimed: Claimed, observation: RemoteObservation): Promise<string> {
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${claimed.orderId} FOR UPDATE`
    const job = await tx.fulfillmentJob.findUnique({ where: { id: claimed.id } })
    // Stale worker (lease lost / re-claimed): its observation must not write.
    if (!job || job.leaseToken !== claimed.leaseToken) return 'stale'
    const order = await tx.order.findUniqueOrThrow({ where: { id: job.orderId } })
    const release = { leaseToken: null, leaseUntil: null }
    const deliverable = !job.cancelRequested && (order.status === 'pending' || order.status === 'processing')

    if (observation.kind === 'succeeded') {
      const evidence = (observation.evidence ?? {}) as Prisma.InputJsonValue
      await tx.fulfillmentJob.update({
        where: { id: job.id },
        data: {
          ...release, status: 'succeeded', evidence, completedAt: new Date(), lastError: null,
          ...(deliverable ? {} : { note: `remote succeeded after order ${order.status}; operator must revoke remotely` }),
        },
      })
      if (!deliverable) {
        logger.error({ jobId: job.id, orderId: job.orderId }, 'fulfillment succeeded after refund; manual remote revoke required')
        return 'succeeded_after_refund'
      }
      await deliverExternalResultInTx(tx, {
        orderId: job.orderId,
        action: { start: `system.${job.providerId}.start`, deliver: `system.${job.providerId}.deliver` },
        startNote: '正在开通',
        publicNote: '已开通',
        internalNote: `operation=${job.operationKey}`,
        deliveryContent: observation.delivery.content,
        deliveryStructuredContent: observation.delivery.structuredContent,
        ...(observation.delivery.expiresAt !== undefined ? { expiresAtOverride: observation.delivery.expiresAt } : {}),
        captureReason: `外部开通成功扣款: #${job.orderId}`,
      })
      return 'delivered'
    }

    if (observation.kind === 'failed_without_effect' || observation.kind === 'cancelled_before_effect') {
      const code = observation.kind === 'failed_without_effect' ? observation.code : 'CANCELLED_BEFORE_EFFECT'
      await tx.fulfillmentJob.update({
        where: { id: job.id },
        data: {
          ...release, status: observation.kind === 'failed_without_effect' ? 'failed' : 'cancelled',
          lastError: code.slice(0, 64), completedAt: new Date(),
        },
      })
      if (order.status === 'pending') {
        await refundUndeliveredExternalOrderInTx(tx, order, {
          action: `system.${job.providerId}.failed_refund`,
          publicNote: '开通失败，积分已退回',
          internalNote: code,
          releaseReason: `外部开通失败退款: #${order.id} (${code})`,
        })
      }
      return 'refunded'
    }

    // processing / unknown / not_found: points stay held.
    const code = observation.kind === 'unknown' ? observation.code : observation.kind.toUpperCase()
    const exhausted = job.status === 'needs_reconcile' || job.cancelRequested || job.attempts >= job.maxAttempts
    await tx.fulfillmentJob.update({
      where: { id: job.id },
      data: {
        ...release,
        lastError: code.slice(0, 64),
        ...(exhausted ? { status: 'needs_reconcile' } : {}),
        ...(observation.kind === 'processing' && observation.retryAfterMs != null
          ? { nextAttemptAt: new Date(Date.now() + observation.retryAfterMs) }
          : {}),
      },
    })
    return exhausted ? 'reconcile' : 'retry'
  })
}

/** Claim, call the adapter and apply one step. Safe to call from any instance. */
export async function processFulfillmentJob(jobId: number): Promise<string> {
  const claimed = await claimJob(jobId)
  if (!claimed) return 'skipped'
  const observation = await observe(adapters.get(claimed.providerId)!, claimed)
  return applyObservation(claimed, observation)
}

export async function runFulfillmentJobBatch(now: Date = new Date()): Promise<number> {
  const due = await prisma.fulfillmentJob.findMany({
    where: {
      status: { in: ['pending', 'needs_reconcile'] },
      providerId: { in: [...adapters.keys()] },
      nextAttemptAt: { lte: now },
      OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }],
    },
    orderBy: { nextAttemptAt: 'asc' },
    take: BATCH_LIMIT,
    select: { id: true },
  })
  let processed = 0
  for (const { id } of due) {
    if ((await processFulfillmentJob(id)) !== 'skipped') processed += 1
  }
  return processed
}

function kick(jobId: number): void {
  if (config.nodeEnv === 'test') return
  setImmediate(() => {
    void processFulfillmentJob(jobId).catch(err => logger.error({ err, jobId }, 'fulfillment job attempt failed'))
  })
}

let timer: NodeJS.Timeout | null = null
let running: Promise<unknown> = Promise.resolve()

function startEngine(): void {
  if (timer || config.nodeEnv === 'test') return
  timer = setInterval(() => {
    running = runFulfillmentJobBatch().catch(err => logger.error({ err }, 'fulfillment job batch failed'))
  }, INTERVAL_MS)
  timer.unref?.()
  logger.info({ intervalMs: INTERVAL_MS }, 'fulfillment job engine started')
}

async function stopEngine(): Promise<void> {
  if (timer) clearInterval(timer)
  timer = null
  await running
}

/** Wrap an adapter into a registrable provider backed by the core job engine. */
export function createJobFulfillmentProvider(adapter: ExternalFulfillmentAdapter): FulfillmentProvider {
  adapters.set(adapter.id, adapter)
  type Prepared = Record<string, unknown>
  type Target = { sku: string; input: Record<string, unknown> }
  return {
    id: adapter.id,
    label: adapter.label,
    checkout: {
      async preview() {
        return adapter.isConfigured() ? {} : { unpurchasableReason: `${adapter.label} 暂不可用` }
      },
      async prepare({ userId, offer, extensionInput }): Promise<Prepared> {
        if (!adapter.isConfigured()) throw badRequest(`${adapter.label} 暂不可用，请稍后再试`)
        return adapter.prepare ? adapter.prepare({ userId, offer, extensionInput }) : {}
      },
      async validateInTx(_tx, { offer, prepared }): Promise<Target> {
        if (offer.deliveryMode !== 'manual_service') throw badRequest('外部开通商品履约模式配置错误，请联系管理员')
        if (!offer.externalSku) throw badRequest('外部开通商品未配置 externalSku')
        return { sku: offer.externalSku, input: prepared as Prepared }
      },
      async createTaskInTx(tx, { orderId, offer, target }) {
        const { sku, input } = target as Target
        // The SKU is the irreversible contract: lock and re-check the binding.
        const recheck = await tx.$queryRaw<Array<{ externalIntegration: string | null; externalSku: string | null; autoProvision: boolean }>>`
          SELECT "externalIntegration", "externalSku", "autoProvision" FROM "Offer" WHERE "id" = ${offer.id} FOR NO KEY UPDATE`
        if (recheck.length === 0 || recheck[0].externalIntegration !== adapter.id
          || recheck[0].externalSku !== sku || recheck[0].autoProvision) {
          throw new HttpError(409, 'CHECKOUT_CHANGED', '商品信息已变化，请重新确认')
        }
        const job = await tx.fulfillmentJob.create({
          data: {
            orderId,
            providerId: adapter.id,
            operationKey: `MN-${adapter.id}-${orderId}`,
            skuSnapshot: sku,
            inputSnapshot: input as Prisma.InputJsonValue,
            maxAttempts: DEFAULT_MAX_ATTEMPTS,
          },
        })
        return () => kick(job.id)
      },
    },
    async onOrderRefundedInTx(tx: Tx, orderId) {
      const job = await tx.fulfillmentJob.findUnique({ where: { orderId } })
      if (!job || job.providerId !== adapter.id) return
      if (job.status !== 'pending' && job.status !== 'needs_reconcile') return
      const leaseActive = job.leaseUntil != null && job.leaseUntil > new Date()
      if (job.status === 'pending' && job.attempts === 0 && !leaseActive) {
        await tx.fulfillmentJob.update({
          where: { id: job.id },
          data: { status: 'cancelled', cancelRequested: true, completedAt: new Date(), note: 'order refunded before dispatch' },
        })
        return
      }
      // Possibly dispatched: never assume nothing happened; cancel or query to converge.
      await tx.fulfillmentJob.update({
        where: { id: job.id },
        data: { cancelRequested: true, ...(leaseActive ? {} : { status: 'needs_reconcile', nextAttemptAt: new Date() }) },
      })
    },
    async afterOrderRefunded(orderId) {
      const job = await prisma.fulfillmentJob.findUnique({ where: { orderId }, select: { id: true, providerId: true, status: true } })
      if (job?.providerId === adapter.id && job.status === 'needs_reconcile') kick(job.id)
    },
    async isProvisionPending(orderId) {
      const job = await prisma.fulfillmentJob.findUnique({ where: { orderId }, select: { providerId: true, status: true } })
      return job?.providerId === adapter.id && job.status === 'pending'
    },
    startBackgroundJobs: startEngine,
    stopBackgroundJobs: stopEngine,
  }
}
