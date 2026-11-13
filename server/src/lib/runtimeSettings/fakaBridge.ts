import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import type { IntegrationConfigRevision, Prisma } from '@prisma/client'
import type { RequestHandler } from 'express'
import { z } from 'zod'
import { config } from '../../config/index.js'
import { prisma } from '../prisma.js'
import { logger } from '../logger.js'
import { conflict, HttpError } from '../httpError.js'
import { decryptIntegrationCredentials } from './credentials.js'
import { httpsOriginSchema } from './shortlink.js'

export const FAKA_KEY = 'faka_bridge'
export const FAKA_LEGACY_KEY = 'faka_bridge:legacy'
const endpoint = (action: string) => z.string().trim().max(2048).url().refine(value => {
  const u = new URL(value)
  return u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash
    && u.pathname.replace(/\/$/, '') === `/plugin/faka-bridge/${action}`
}, '请输入对应 FakaBridge HTTPS 接口地址')
export const fakaSettingsSchema = z.object({
  url: endpoint('order-paid'), statusUrl: endpoint('order-status'), revokeUrl: endpoint('order-revoke'),
  timeoutMs: z.number().int().min(1000).max(60000), maxAttempts: z.number().int().min(1).max(10),
  panelUrl: httpsOriginSchema, instanceId: z.string().uuid().nullable(),
  clientId: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/),
}).strict().refine(s => [s.statusUrl, s.revokeUrl].every(url => new URL(url).origin === new URL(s.url).origin), '履约接口必须属于同一个站点')
export const fakaCredentialsSchema = z.object({ secret: z.string().min(16).max(4096).refine(v => !/[\r\n\0]/.test(v)) }).strict()
export type FakaSettings = z.infer<typeof fakaSettingsSchema>
export type FakaSnapshot = { revisionId: string | null; bridge: typeof config.fakaBridge; instanceId: string | null; clientId: string }
const context = new AsyncLocalStorage<FakaSnapshot>()
export function fakaBootstrap(): FakaSnapshot {
  return { revisionId: null, bridge: { ...config.fakaBridge }, instanceId: config.xboardAccounts.instanceId ?? null, clientId: config.trafficReset.clientId }
}
export function currentFakaSnapshot() { return context.getStore() ?? fakaBootstrap() }
export function fakaBridgeConfig() { return currentFakaSnapshot().bridge }
export function fakaInstanceId() { return currentFakaSnapshot().instanceId }
export function fakaClientId() { return currentFakaSnapshot().clientId }
export function fakaCacheIdentity() {
  const s = currentFakaSnapshot()
  return s.revisionId ?? createHash('sha256').update(JSON.stringify([s.bridge, s.instanceId, s.clientId])).digest('hex')
}
export function withFakaSnapshot<T>(snapshot: FakaSnapshot, work: () => T): T { return context.run(snapshot, work) }
export function fakaPublicBootstrap() {
  const { bridge: b, instanceId, clientId } = fakaBootstrap()
  if (!b.enabled || !b.url || !b.secret) return null
  return { url: b.url, statusUrl: b.statusUrl ?? b.url.replace(/\/order-paid\/?$/, '/order-status'),
    revokeUrl: b.revokeUrl ?? b.url.replace(/\/order-paid\/?$/, '/order-revoke'), timeoutMs: b.timeoutMs,
    maxAttempts: b.maxAttempts, panelUrl: b.panelUrl, instanceId, clientId }
}
class FakaConfigurationUnavailableError extends HttpError {
  constructor() { super(503, 'INTERNAL_SERVER_ERROR', '履约配置凭据不可用，请联系管理员恢复对应密钥') }
}
export function decodeFakaRevision(revision: IntegrationConfigRevision): FakaSnapshot {
  try {
    if (revision.key !== FAKA_KEY || !revision.credentialsCiphertext) throw new Error()
    const s = fakaSettingsSchema.parse(revision.settings)
    const credentials = fakaCredentialsSchema.parse(decryptIntegrationCredentials(FAKA_KEY, revision.id, s, revision.credentialsCiphertext))
    return { revisionId: revision.id, bridge: { ...s, ...credentials, enabled: true, allowInsecureTargets: false }, instanceId: s.instanceId, clientId: s.clientId }
  } catch { throw new FakaConfigurationUnavailableError() }
}
type Db = Pick<Prisma.TransactionClient, 'integrationConfig' | 'integrationConfigRevision'>
export async function activeFakaSnapshot(db: Db = prisma): Promise<FakaSnapshot> {
  const row = await db.integrationConfig.findUnique({ where: { key: FAKA_KEY }, include: { activeRevision: true } })
  const snapshot = row?.activeRevisionId ? decodeFakaRevision(row.activeRevision!) : fakaBootstrap()
  return row && !row.enabled ? { ...snapshot, bridge: { ...snapshot.bridge, enabled: false, url: undefined, secret: undefined } as typeof config.fakaBridge } : snapshot
}
export async function historicalFakaSnapshot(revisionId: string | null, db: Db = prisma): Promise<FakaSnapshot> {
  if (revisionId) return decodeFakaRevision(await db.integrationConfigRevision.findUniqueOrThrow({ where: { id: revisionId } }))
  const legacy = await db.integrationConfig.findUnique({ where: { key: FAKA_LEGACY_KEY }, include: { activeRevision: true } })
  if (legacy?.activeRevision) return decodeFakaRevision(legacy.activeRevision)
  // Legacy operations never resolve the current active configuration.
  return fakaBootstrap()
}
async function taskSnapshot(taskId: number): Promise<FakaSnapshot> {
  const task = await prisma.fakaBridgeTask.findUnique({ where: { id: taskId }, select: { configRevisionId: true } })
  return historicalFakaSnapshot(task?.configRevisionId ?? null)
}
export async function withFakaTask<T>(taskId: number, work: () => Promise<T>): Promise<T> {
  return withFakaSnapshot(await taskSnapshot(taskId), work)
}
/** A damaged historical credential must not block other revisions in the queue. */
export async function withFakaTaskInBatch<T>(taskId: number, work: () => Promise<T>, skipped: T): Promise<T> {
  let snapshot: FakaSnapshot
  try {
    snapshot = await taskSnapshot(taskId)
  } catch (error) {
    if (!(error instanceof FakaConfigurationUnavailableError)) throw error
    const now = new Date()
    const retryAt = new Date(now.getTime() + 5 * 60_000)
    // Do not change bindings, business state or another worker's active lease.
    await prisma.$executeRaw`
      UPDATE "FakaBridgeTask"
      SET "nextAttemptAt" = GREATEST("nextAttemptAt", ${retryAt}), "lastError" = 'CONFIG_UNAVAILABLE'
      WHERE "id" = ${taskId}
        AND ("leaseUntil" IS NULL OR ("leaseUntil" AT TIME ZONE 'UTC') <= ${now})`
    logger.warn({ taskId, code: 'CONFIG_UNAVAILABLE' }, 'FakaBridge historical configuration unavailable; task deferred')
    return skipped
  }
  return withFakaSnapshot(snapshot, work)
}
export async function withActiveFaka<T>(work: () => Promise<T>): Promise<T> {
  return withFakaSnapshot(await activeFakaSnapshot(), work)
}
/** Pin the request's snapshot under the same lock as activation. An edited target requires retry. */
export async function pinFakaSnapshot(tx: Prisma.TransactionClient): Promise<string | null> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('monexus:integration:faka_bridge'))`
  const snapshot = currentFakaSnapshot()
  const active = await activeFakaSnapshot(tx)
  if (!active.bridge.enabled || !active.bridge.url || !active.bridge.secret) throw new HttpError(503, 'INTERNAL_SERVER_ERROR', '新履约暂未开放')
  if (snapshot.revisionId !== active.revisionId || snapshot.bridge.url !== active.bridge.url || snapshot.bridge.secret !== active.bridge.secret) throw conflict('履约配置已变化，请重新确认')
  return snapshot.revisionId
}
export const fakaRuntimeMiddleware: RequestHandler = (req, _res, next) => {
  if (!/^\/(products|orders|checkout|faka-bridge|bot|shops|storefront|merchant)(\/|$)/.test(req.path)
    && !/^\/admin\/(faka|products|offers)/.test(req.path)) return next()
  void activeFakaSnapshot().then(snapshot => withFakaSnapshot(snapshot, () => next())).catch(next)
}
