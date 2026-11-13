import { randomUUID } from 'node:crypto'
import { Prisma, type IntegrationConfig } from '@prisma/client'
import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { z } from 'zod'
import { config } from '../../config/index.js'
import { prisma } from '../../lib/prisma.js'
import { badRequest, conflict, forbidden, HttpError } from '../../lib/httpError.js'
import { encryptIntegrationCredentials, decryptIntegrationCredentials } from '../../lib/runtimeSettings/credentials.js'
import { shortlinkBootstrap, shortlinkCredentialsSchema, shortlinkSettingsSchema } from '../../lib/runtimeSettings/shortlink.js'
import { createShortlinkClient, ShortlinkError } from '../../lib/shortlinkClient.js'
import { validate } from '../../middlewares/validate.js'

const KEY = 'shortlink'
const expectedVersionSchema = z.number().int().min(0).max(2147483646)
const versionBody = z.object({ expectedVersion: expectedVersionSchema }).strict()
const saveBody = shortlinkSettingsSchema.extend({ expectedVersion: expectedVersionSchema, credentials: shortlinkCredentialsSchema.optional() }).strict()
const enabledBody = versionBody.extend({ enabled: z.boolean() }).strict()
const versionMatches = (row: IntegrationConfig | null, expected: number) => {
  if ((row?.version ?? 0) !== expected) throw conflict('配置已被更新，请重新加载后操作')
}
async function locked<T>(work: (tx: Prisma.TransactionClient, row: IntegrationConfig | null) => Promise<T>) {
  return prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('monexus:integration:shortlink'))`
    return work(tx, await tx.integrationConfig.findUnique({ where: { key: KEY } }))
  })
}
function dto(row: IntegrationConfig | null) {
  const bootstrap = shortlinkBootstrap()
  return {
    version: row?.version ?? 0, activeRevisionId: row?.activeRevisionId ?? null,
    source: row?.activeRevisionId ? 'database' : 'environment', enabled: row?.enabled ?? true,
    encryptionReady: Boolean(config.integrationCredentialsEncKey),
    draft: row?.draft ? shortlinkSettingsSchema.parse(row.draft) : null,
    bootstrap: bootstrap ? shortlinkSettingsSchema.parse({ apiBaseUrl: bootstrap.apiBaseUrl, publicOrigin: bootstrap.publicOrigin, groupId: bootstrap.groupId }) : null,
    credentialsConfigured: row?.draft ? Boolean(row.draftCredentialsCiphertext) : Boolean(bootstrap),
    tested: Boolean(row?.draft && row.testedVersion === row.version),
    rollbackAvailable: row?.rollbackAvailable ?? false, updatedAt: row?.updatedAt ?? null,
  }
}
async function audit(tx: Pick<Prisma.TransactionClient, 'adminLog'>, actor: number, action: string, version: number, phase?: string) {
  await tx.adminLog.create({ data: { adminUserId: actor, action: `integration.${action}`, targetType: 'integrationConfig',
    detail: JSON.stringify({ service: KEY, version, ...(phase ? { phase } : {}) }),
  } })
}
function credentialsForDraft(row: IntegrationConfig) {
  const settings = shortlinkSettingsSchema.parse(row.draft)
  if (!row.draftCredentialsCiphertext) throw badRequest('请填写短链服务账号和密码')
  try {
    if (!row.draftRevisionId) throw new Error('Invalid draft identity')
    return { settings, credentials: shortlinkCredentialsSchema.parse(decryptIntegrationCredentials(KEY, row.draftRevisionId, settings, row.draftCredentialsCiphertext)) }
  } catch { throw badRequest('凭据不可用，请重新填写账号和密码') }
}
export async function saveShortlinkDraft(actor: number, input: z.infer<typeof saveBody>) {
  return locked(async (tx, row) => {
    versionMatches(row, input.expectedVersion)
    if (!config.integrationCredentialsEncKey) throw forbidden('服务器尚未配置集成凭据加密密钥')
    const { expectedVersion: _version, credentials: replacement, ...settings } = input
    let credentials = replacement
    const bootstrap = shortlinkBootstrap()
    const previous = row?.draft ? shortlinkSettingsSchema.parse(row.draft) : bootstrap
    if (!replacement && previous && previous.apiBaseUrl !== settings.apiBaseUrl) throw badRequest('更换 API 地址时请重新填写账号和密码')
    if (!credentials && row?.draft) credentials = credentialsForDraft(row).credentials
    if (!credentials && !row?.draft && bootstrap) credentials = { username: bootstrap.username, password: bootstrap.password }
    if (!credentials) throw badRequest('请填写短链服务账号和密码')
    const version = (row?.version ?? 0) + 1
    const draftRevisionId = randomUUID()
    const draftCredentialsCiphertext = encryptIntegrationCredentials(KEY, draftRevisionId, settings, credentials)
    const updated = await tx.integrationConfig.upsert({ where: { key: KEY },
      create: { key: KEY, version, draft: settings, draftRevisionId, draftCredentialsCiphertext, updatedBy: actor },
      update: { version, draft: settings, draftRevisionId, draftCredentialsCiphertext, testedVersion: null, updatedBy: actor },
    })
    await audit(tx, actor, 'draft.save', version)
    return dto(updated)
  })
}
export async function testShortlinkDraft(actor: number, expectedVersion: number) {
  const row = await prisma.integrationConfig.findUnique({ where: { key: KEY } })
  versionMatches(row, expectedVersion)
  if (!row?.draft) throw badRequest('请先保存短链配置草稿')
  const { settings, credentials } = credentialsForDraft(row)
  await audit(prisma, actor, 'draft.test', row.version, 'attempt')
  try { await createShortlinkClient({ config: { ...settings, ...credentials } }).testAuthentication() }
  catch (err) {
    await audit(prisma, actor, 'draft.test', row.version, 'failed')
    throw new HttpError(502, 'INTERNAL_SERVER_ERROR', err instanceof ShortlinkError && err.kind === 'timeout' ? '短链登录探测超时' : '短链登录探测失败，请检查地址和凭据')
  }
  await audit(prisma, actor, 'draft.test', row.version, 'authenticated')
  return locked(async (tx, latest) => {
    versionMatches(latest, expectedVersion)
    return dto(await tx.integrationConfig.update({ where: { key: KEY }, data: { testedVersion: expectedVersion } }))
  })
}
export async function activateShortlinkDraft(actor: number, expectedVersion: number) {
  return locked(async (tx, row) => {
    versionMatches(row, expectedVersion)
    if (!config.integrationCredentialsEncKey) throw forbidden('服务器尚未配置当前集成凭据加密密钥')
    if (!row?.draft || row.testedVersion !== row.version) throw badRequest('请先完成当前草稿的登录探测')
    const { settings, credentials } = credentialsForDraft(row)
    const id = randomUUID()
    await tx.integrationConfigRevision.create({ data: { id, key: KEY, settings,
      credentialsCiphertext: encryptIntegrationCredentials(KEY, id, settings, credentials), createdBy: actor,
    } })
    const updated = await tx.integrationConfig.update({ where: { key: KEY }, data: {
      previousRevisionId: row.activeRevisionId, previousEnabled: row.enabled,
      activeRevisionId: id, enabled: true, rollbackAvailable: true,
      version: { increment: 1 }, testedVersion: null, updatedBy: actor,
    } })
    await audit(tx, actor, 'activate', updated.version)
    return dto(updated)
  })
}
export async function rollbackShortlinkConfig(actor: number, expectedVersion: number) {
  return locked(async (tx, row) => {
    versionMatches(row, expectedVersion)
    if (!row?.rollbackAvailable) throw badRequest('没有可回滚的配置')
    if (row.previousRevisionId) {
      const revision = await tx.integrationConfigRevision.findUniqueOrThrow({ where: { id: row.previousRevisionId } })
      try {
        if (revision.key !== KEY || !revision.credentialsCiphertext) throw new Error('Invalid revision')
        const settings = shortlinkSettingsSchema.parse(revision.settings)
        shortlinkCredentialsSchema.parse(decryptIntegrationCredentials(KEY, revision.id, settings, revision.credentialsCiphertext))
      } catch { throw badRequest('上一版凭据不可用，请恢复对应加密密钥') }
    }
    const updated = await tx.integrationConfig.update({ where: { key: KEY }, data: {
      activeRevisionId: row.previousRevisionId, enabled: row.previousEnabled,
      previousRevisionId: row.activeRevisionId, previousEnabled: row.enabled,
      version: { increment: 1 }, testedVersion: null, updatedBy: actor,
    } })
    await audit(tx, actor, 'rollback', updated.version)
    return dto(updated)
  })
}
async function setShortlinkEnabled(actor: number, expectedVersion: number, enabled: boolean) {
  return locked(async (tx, row) => {
    versionMatches(row, expectedVersion)
    const updated = await tx.integrationConfig.upsert({ where: { key: KEY },
      create: { key: KEY, version: 1, enabled, updatedBy: actor },
      update: { enabled, version: { increment: 1 }, testedVersion: null, updatedBy: actor },
    })
    await audit(tx, actor, enabled ? 'enable' : 'disable', updated.version)
    return dto(updated)
  })
}
export async function rewrapShortlinkCredentials(actor: number, expectedVersion: number) {
  return locked(async (tx, row) => {
    versionMatches(row, expectedVersion)
    if (!row || !config.integrationCredentialsEncKey) throw badRequest('请先配置当前加密密钥')
    // One transaction: failure to recover any retained version leaves every ciphertext unchanged.
    const revisions = await tx.integrationConfigRevision.findMany({ where: { key: KEY } })
    for (const revision of revisions) {
      if (!revision.credentialsCiphertext) throw badRequest('历史版本凭据不可用')
      const settings = shortlinkSettingsSchema.parse(revision.settings)
      let credentials
      try { credentials = shortlinkCredentialsSchema.parse(decryptIntegrationCredentials(KEY, revision.id, settings, revision.credentialsCiphertext)) }
      catch { throw badRequest('历史版本凭据不可用，请保留原加密密钥') }
      await tx.integrationConfigRevision.update({ where: { id: revision.id }, data: {
        credentialsCiphertext: encryptIntegrationCredentials(KEY, revision.id, settings, credentials),
      } })
    }
    const draft = row.draft ? credentialsForDraft(row) : null
    const updated = await tx.integrationConfig.update({ where: { key: KEY }, data: {
      ...(draft ? { draftCredentialsCiphertext: encryptIntegrationCredentials(KEY, row.draftRevisionId!, draft.settings, draft.credentials) } : {}),
      version: { increment: 1 }, testedVersion: null, updatedBy: actor,
    } })
    await audit(tx, actor, 'credentials.rewrap', updated.version)
    return dto(updated)
  })
}
export const integrationProbeLimiter = rateLimit({ windowMs: 10 * 60_000, limit: 5, keyGenerator: req => String(req.user!.userId), standardHeaders: 'draft-8', legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({ error: { code: 'RATE_LIMITED', message: '探测次数过多，请稍后重试' } }),
})
export const integrationSettingsRoutes = Router()
const base = '/integrations/shortlink/config'
integrationSettingsRoutes.use(base, (_req, res, next) => { res.set('Cache-Control', 'no-store'); next() })
integrationSettingsRoutes.get(base, async (_req, res, next) => {
  try { res.json(dto(await prisma.integrationConfig.findUnique({ where: { key: KEY } }))) } catch (err) { next(err) }
})
integrationSettingsRoutes.put(base, validate(saveBody), async (req, res, next) => {
  try { res.json(await saveShortlinkDraft(req.user!.userId, req.body)) } catch (err) { next(err) }
})
for (const [action, operation] of Object.entries({ test: testShortlinkDraft, activate: activateShortlinkDraft, rollback: rollbackShortlinkConfig, rewrap: rewrapShortlinkCredentials })) {
  integrationSettingsRoutes.post(`${base}/${action}`, ...(action === 'test' ? [integrationProbeLimiter] : []), validate(versionBody), async (req, res, next) => {
    try { res.json(await operation(req.user!.userId, req.body.expectedVersion)) } catch (err) { next(err) }
  })
}
integrationSettingsRoutes.post(`${base}/enabled`, validate(enabledBody), async (req, res, next) => {
  try { res.json(await setShortlinkEnabled(req.user!.userId, req.body.expectedVersion, req.body.enabled)) } catch (err) { next(err) }
})
