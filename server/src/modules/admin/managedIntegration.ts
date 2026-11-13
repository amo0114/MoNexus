import { randomUUID } from 'node:crypto'
import type { IntegrationConfig, Prisma } from '@prisma/client'
import { Router } from 'express'
import { z } from 'zod'
import { config } from '../../config/index.js'
import { prisma } from '../../lib/prisma.js'
import { badRequest, conflict, forbidden, HttpError } from '../../lib/httpError.js'
import { decryptIntegrationCredentials, encryptIntegrationCredentials } from '../../lib/runtimeSettings/credentials.js'
import { validate } from '../../middlewares/validate.js'
import { integrationProbeLimiter } from './integrationSettings.js'

type JsonObject = Record<string, unknown>
type Tx = Prisma.TransactionClient
export interface ManagedIntegration<S extends JsonObject, C extends JsonObject> {
  key: string
  settings: z.ZodType<S>
  credentials: z.ZodType<C>
  bootstrap: () => { settings: S; credentials: C } | null
  sameDestination: (a: S, b: S) => boolean
  test: (settings: S, credentials: C) => Promise<void>
  testKind: 'read_only' | 'local_validation'
  publicDetails?: (draft: S | null) => Record<string, unknown>
  accountIdForRevision?: (tx: Tx, settings: S) => Promise<string>
  beforeActivate?: (tx: Tx, row: IntegrationConfig, settings: S, actor: number, legacyConfirmed: boolean) => Promise<string | null>
}
const version = z.object({ expectedVersion: z.number().int().min(0).max(2147483646) }).strict()
export function managedIntegration<S extends JsonObject, C extends JsonObject>(definition: ManagedIntegration<S, C>) {
  const { key } = definition
  async function locked<T>(work: (tx: Tx, row: IntegrationConfig | null) => Promise<T>) {
    return prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`monexus:integration:${key}`}))`
      return work(tx, await tx.integrationConfig.findUnique({ where: { key } }))
    })
  }
  function match(row: IntegrationConfig | null, expected: number) {
    if ((row?.version ?? 0) !== expected) throw conflict('配置已被更新，请重新加载后操作')
  }
  function requireRoot() { if (!config.integrationCredentialsEncKey) throw forbidden('服务器尚未配置当前集成凭据加密密钥') }
  function dto(row: IntegrationConfig | null) {
    const bootstrap = definition.bootstrap()
    return { version: row?.version ?? 0, activeRevisionId: row?.activeRevisionId ?? null,
      source: row?.activeRevisionId ? 'database' : 'environment', enabled: row?.enabled ?? true,
      encryptionReady: Boolean(config.integrationCredentialsEncKey),
      draft: row?.draft ? definition.settings.parse(row.draft) : null, bootstrap: bootstrap?.settings ?? null,
      credentialsConfigured: row?.draft ? Boolean(row.draftCredentialsCiphertext) : Boolean(bootstrap),
      tested: Boolean(row?.draft && row.testedVersion === row.version), testKind: definition.testKind,
      rollbackAvailable: row?.rollbackAvailable ?? false, updatedAt: row?.updatedAt ?? null,
      ...definition.publicDetails?.(row?.draft ? definition.settings.parse(row.draft) : null) }
  }
  async function audit(tx: Pick<Tx, 'adminLog'>, actor: number, action: string, controlVersion: number, phase?: string) {
    await tx.adminLog.create({ data: { adminUserId: actor, action: `integration.${action}`, targetType: 'integrationConfig',
      detail: JSON.stringify({ service: key, version: controlVersion, ...(phase ? { phase } : {}) }) } })
  }
  function decode(settings: S, identity: string | null, ciphertext: string | null): C {
    try {
      if (!identity || !ciphertext) throw new Error()
      return definition.credentials.parse(decryptIntegrationCredentials(key, identity, settings, ciphertext))
    } catch { throw badRequest('凭据不可用，请恢复原加密密钥或重新填写') }
  }
  const api = {
    get: async () => dto(await prisma.integrationConfig.findUnique({ where: { key } })),
    save: async (actor: number, input: { expectedVersion: number; settings: S; credentials?: C }) => locked(async (tx, row) => {
      match(row, input.expectedVersion); requireRoot()
      const settings = definition.settings.parse(input.settings)
      const bootstrap = definition.bootstrap()
      const previous = row?.draft ? definition.settings.parse(row.draft) : bootstrap?.settings
      if (!input.credentials && previous && !definition.sameDestination(previous, settings)) throw badRequest('更换目标或账号身份时请重新填写凭据')
      const credentials = input.credentials ? definition.credentials.parse(input.credentials)
        : row?.draft ? decode(definition.settings.parse(row.draft), row.draftRevisionId, row.draftCredentialsCiphertext) : bootstrap?.credentials
      if (!credentials) throw badRequest('请填写服务凭据')
      const id = randomUUID(), ciphertext = encryptIntegrationCredentials(key, id, settings, credentials)
      const data = { draft: settings as Prisma.InputJsonObject, draftRevisionId: id, draftCredentialsCiphertext: ciphertext, testedVersion: null, updatedBy: actor }
      const updated = await tx.integrationConfig.upsert({ where: { key }, create: { key, version: 1, ...data }, update: { version: { increment: 1 }, ...data } })
      await audit(tx, actor, 'draft.save', updated.version); return dto(updated)
    }),
    test: async (actor: number, expected: number) => {
      const row = await prisma.integrationConfig.findUnique({ where: { key } }); match(row, expected)
      if (!row?.draft) throw badRequest('请先保存配置草稿')
      const settings = definition.settings.parse(row.draft), credentials = decode(settings, row.draftRevisionId, row.draftCredentialsCiphertext)
      await audit(prisma, actor, 'draft.test', expected, 'attempt')
      try { await definition.test(settings, credentials) }
      catch { await audit(prisma, actor, 'draft.test', expected, 'failed'); throw new HttpError(502, 'INTERNAL_SERVER_ERROR', '配置校验或只读探测失败，请检查参数和凭据') }
      await audit(prisma, actor, 'draft.test', expected, definition.testKind)
      return locked(async (tx, latest) => { match(latest, expected); return dto(await tx.integrationConfig.update({ where: { key }, data: { testedVersion: expected } })) })
    },
    activate: async (actor: number, expected: number, legacyConfirmed = false) => locked(async (tx, row) => {
      match(row, expected); requireRoot()
      if (!row?.draft || row.testedVersion !== row.version) throw badRequest('请先校验当前配置草稿')
      const settings = definition.settings.parse(row.draft), credentials = decode(settings, row.draftRevisionId, row.draftCredentialsCiphertext)
      const baseline = await definition.beforeActivate?.(tx, row, settings, actor, legacyConfirmed) ?? null
      const id = randomUUID()
      await tx.integrationConfigRevision.create({ data: { id, key, paymentAccountId: await definition.accountIdForRevision?.(tx, settings) ?? null, settings: settings as Prisma.InputJsonObject,
        credentialsCiphertext: encryptIntegrationCredentials(key, id, settings, credentials), createdBy: actor } })
      const updated = await tx.integrationConfig.update({ where: { key }, data: { activeRevisionId: id,
        previousRevisionId: row.activeRevisionId ?? baseline, previousEnabled: row.enabled,
        enabled: true, rollbackAvailable: true, testedVersion: null, version: { increment: 1 }, updatedBy: actor } })
      await audit(tx, actor, 'activate', updated.version); return dto(updated)
    }),
    rollback: async (actor: number, expected: number) => locked(async (tx, row) => {
      match(row, expected)
      if (!row?.rollbackAvailable) throw badRequest('没有可回滚的配置')
      if (row.previousRevisionId) {
        const previous = await tx.integrationConfigRevision.findUniqueOrThrow({ where: { id: row.previousRevisionId } })
        if (previous.key !== key) throw badRequest('回滚配置身份不匹配')
        decode(definition.settings.parse(previous.settings), previous.id, previous.credentialsCiphertext)
      }
      const updated = await tx.integrationConfig.update({ where: { key }, data: { activeRevisionId: row.previousRevisionId,
        previousRevisionId: row.activeRevisionId, enabled: row.previousEnabled, previousEnabled: row.enabled,
        version: { increment: 1 }, testedVersion: null, updatedBy: actor } })
      await audit(tx, actor, 'rollback', updated.version); return dto(updated)
    }),
    enabled: async (actor: number, expected: number, enabled: boolean) => locked(async (tx, row) => {
      match(row, expected)
      const updated = await tx.integrationConfig.upsert({ where: { key }, create: { key, version: 1, enabled, updatedBy: actor },
        update: { enabled, version: { increment: 1 }, testedVersion: null, updatedBy: actor } })
      await audit(tx, actor, enabled ? 'enable' : 'disable', updated.version); return dto(updated)
    }),
    rewrap: async (actor: number, expected: number) => locked(async (tx, row) => {
      match(row, expected); requireRoot()
      if (!row) throw badRequest('配置尚未保存')
      for (const revision of await tx.integrationConfigRevision.findMany({ where: { key } })) {
        const settings = definition.settings.parse(revision.settings), credentials = decode(settings, revision.id, revision.credentialsCiphertext)
        await tx.integrationConfigRevision.update({ where: { id: revision.id }, data: { credentialsCiphertext: encryptIntegrationCredentials(key, revision.id, settings, credentials) } })
      }
      const settings = row.draft ? definition.settings.parse(row.draft) : null
      const updated = await tx.integrationConfig.update({ where: { key }, data: { version: { increment: 1 }, testedVersion: null, updatedBy: actor,
        ...(settings ? { draftCredentialsCiphertext: encryptIntegrationCredentials(key, row.draftRevisionId!, settings, decode(settings, row.draftRevisionId, row.draftCredentialsCiphertext)) } : {}) } })
      await audit(tx, actor, 'credentials.rewrap', updated.version); return dto(updated)
    }),
  }
  const router = Router()
  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next() })
  router.get('/', async (_req, res, next) => { try { res.json(await api.get()) } catch (err) { next(err) } })
  router.put('/', validate(z.object({ expectedVersion: version.shape.expectedVersion, settings: definition.settings, credentials: definition.credentials.optional() }).strict()), async (req, res, next) => {
    try { res.json(await api.save(req.user!.userId, req.body)) } catch (err) { next(err) }
  })
  for (const action of ['test', 'activate', 'rollback', 'rewrap'] as const) {
    router.post(`/${action}`, ...(action === 'test' ? [integrationProbeLimiter] : []), validate(action === 'activate' ? version.extend({ legacyConfirmed: z.boolean().optional() }) : version), async (req, res, next) => {
      try { res.json(await api[action](req.user!.userId, req.body.expectedVersion, req.body.legacyConfirmed)) } catch (err) { next(err) }
    })
  }
  router.post('/enabled', validate(version.extend({ enabled: z.boolean() })), async (req, res, next) => {
    try { res.json(await api.enabled(req.user!.userId, req.body.expectedVersion, req.body.enabled)) } catch (err) { next(err) }
  })
  return { api, router }
}
