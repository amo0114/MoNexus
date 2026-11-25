import { access } from 'node:fs/promises'
import type { RequestHandler } from 'express'
import { config } from '../config/index.js'
import type { OptionalFulfillmentPlugin } from '../extension-contracts/optionalFulfillment.js'
import { conflict, HttpError } from '../lib/httpError.js'
import { logger } from '../lib/logger.js'
import { prisma } from '../lib/prisma.js'
import { registerFulfillmentProvider, unregisterFulfillmentProvider } from '../modules/fulfillment/registry.js'

const providerId = 'faka_bridge'
const stateKey = `plugin:${providerId}`
const entry = new URL(import.meta.url.endsWith('.ts')
  ? '../plugins/fakaBridge/entry.ts' : '../plugins/fakaBridge/entry.js', import.meta.url)
let artifact: OptionalFulfillmentPlugin | undefined
let installed = false
let mounted: OptionalFulfillmentPlugin | undefined
let refresh: Promise<void> | undefined
let checkedAt = 0
let timer: ReturnType<typeof setTimeout> | undefined
let workersEnabled = false
const activeRequests = new Set<Promise<void>>()

async function artifactExists() {
  try {
    await access(entry)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function loadArtifact(): Promise<OptionalFulfillmentPlugin | undefined> {
  installed = await artifactExists()
  if (!installed) return
  if (artifact) return artifact
  const { plugin } = await import('../plugins/fakaBridge/entry.js')
  if (plugin.contractVersion !== 1 || plugin.provider.id !== providerId) throw new Error('Incompatible FakaBridge plugin')
  artifact = plugin
  return artifact
}

async function reconcile(): Promise<void> {
  installed = await artifactExists()
  if (!installed && !mounted) return
  const state = await prisma.integrationConfig.findUnique({ where: { key: stateKey }, select: { enabled: true } })
  if (installed && state?.enabled !== false && !mounted) {
    const plugin = await loadArtifact()
    if (!plugin) return
    try { await plugin.assertReady() }
    catch (error) {
      if (error instanceof HttpError && error.status === 409) return
      throw error
    }
    registerFulfillmentProvider(plugin.provider)
    try {
      if (workersEnabled) plugin.provider.startBackgroundJobs?.()
      mounted = plugin
    } catch (error) {
      await plugin.provider.stopBackgroundJobs?.()
      unregisterFulfillmentProvider(plugin.provider)
      throw error
    }
  } else if (state?.enabled === false && mounted) {
    const draining = mounted
    mounted = undefined
    try {
      await Promise.all([draining.provider.stopBackgroundJobs?.(), ...activeRequests])
      unregisterFulfillmentProvider(draining.provider)
    } catch (error) {
      mounted = draining
      throw error
    }
  }
}

export async function refreshOptionalFulfillment(force = false): Promise<void> {
  if (refresh) {
    await refresh
    if (!force) return
  }
  if (!force && Date.now() - checkedAt < 1_000) return
  if (!refresh) {
    refresh = reconcile().then(() => { checkedAt = Date.now() })
      .finally(() => { refresh = undefined })
  }
  await refresh
}

export function startOptionalFulfillmentWorkers(): void {
  if (workersEnabled) return
  workersEnabled = true
  // Mounted providers were started by the standard fulfillment worker bootstrap.
  const poll = () => {
    if (!workersEnabled) return
    timer = setTimeout(() => {
      void refreshOptionalFulfillment().catch(error => {
        logger.error({ err: error }, 'optional fulfillment reconciliation failed')
      }).finally(poll)
    }, 3_000)
    timer.unref()
  }
  poll()
}

export async function stopOptionalFulfillmentWatcher(): Promise<void> {
  workersEnabled = false
  clearTimeout(timer)
  await refresh?.catch(error => logger.error({ err: error }, 'optional fulfillment shutdown failed'))
}

export function optionalFulfillmentStatus() {
  return { id: providerId, installed, mounted: Boolean(mounted) }
}

export async function setOptionalFulfillmentMounted(enabled: boolean, actor: number) {
  const plugin = await loadArtifact()
  if (!plugin) throw new HttpError(404, 'NOT_FOUND', '插件制品尚未部署')
  if (enabled) await plugin.assertReady()
  await prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`monexus:integration:${providerId}`}))`
    const previous = await tx.integrationConfig.findUnique({ where: { key: stateKey } })
    if (previous?.enabled === enabled) return
    if (!enabled) {
      const settings = await tx.integrationConfig.findUnique({ where: { key: providerId }, select: { enabled: true } })
      if (settings?.enabled === true || (!settings && config.fakaBridge.enabled)) throw conflict('请先暂停接单')
      await plugin.assertDetachable(tx)
    }
    await tx.integrationConfig.upsert({
      where: { key: stateKey },
      create: { key: stateKey, enabled, version: 1, updatedBy: actor },
      update: { enabled, version: { increment: 1 }, updatedBy: actor },
    })
    await tx.adminLog.create({ data: {
      adminUserId: actor, action: enabled ? 'plugin.attach' : 'plugin.detach',
      targetType: 'fulfillmentPlugin', detail: providerId,
    } })
  })
  await refreshOptionalFulfillment(true)
  return optionalFulfillmentStatus()
}

export function optionalFulfillmentHandler(
  surface: 'runtimeContext' | 'buyerRoutes' | 'rawBotRoutes' | 'adminRoutes',
): RequestHandler {
  return (req, res, next) => {
    void refreshOptionalFulfillment().then(() => {
      const handler = mounted?.[surface]
      if (!handler) return next()
      if (surface === 'runtimeContext') return handler(req, res, next)
      let complete!: () => void
      const pending = new Promise<void>(resolve => { complete = resolve })
      const finish = () => {
        res.off('finish', finish)
        res.off('close', finish)
        activeRequests.delete(pending)
        complete()
      }
      activeRequests.add(pending)
      res.once('finish', finish)
      res.once('close', finish)
      return handler(req, res, error => { finish(); next(error) })
    }).catch(next)
  }
}
