import { randomUUID } from 'node:crypto'
import { badRequest } from '../../lib/httpError.js'
import { fakaCredentialsSchema, fakaSettingsSchema, fakaPublicBootstrap, fakaBootstrap, FAKA_KEY, FAKA_LEGACY_KEY, withFakaSnapshot } from '../../lib/runtimeSettings/fakaBridge.js'
import { encryptIntegrationCredentials } from '../../lib/runtimeSettings/credentials.js'
import { callFakaPlanCatalog } from '../../lib/fakaBridge/client.js'
import { callFakaV2Capabilities } from '../../lib/fakaBridge/accountV2.js'
import { managedIntegration } from './managedIntegration.js'

export const fakaSettings = managedIntegration({
  key: FAKA_KEY, settings: fakaSettingsSchema, credentials: fakaCredentialsSchema,
  bootstrap: () => {
    const settings = fakaPublicBootstrap(), b = fakaBootstrap()
    const parsed = fakaSettingsSchema.safeParse(settings)
    return parsed.success && b.bridge.secret ? { settings: parsed.data, credentials: { secret: b.bridge.secret } } : null
  },
  sameDestination: (a, b) => a.url === b.url && a.statusUrl === b.statusUrl && a.revokeUrl === b.revokeUrl && a.instanceId === b.instanceId && a.clientId === b.clientId,
  testKind: 'read_only',
  test: async (s, c) => withFakaSnapshot({ revisionId: null, bridge: { ...s, ...c, enabled: true, allowInsecureTargets: false }, instanceId: s.instanceId, clientId: s.clientId }, async () => {
    const catalog = await callFakaPlanCatalog()
    if (!catalog.ok || !catalog.body?.success) throw new Error('Catalog probe failed')
    if (s.instanceId) {
      const caps = await callFakaV2Capabilities()
      if (!caps.ok || !caps.body.capabilities.resolve_by_order || !caps.body.capabilities.subscription_by_user_id) throw new Error('Capability probe failed')
    }
  }),
  beforeActivate: async (tx, row, settings, actor, legacyConfirmed) => {
    if (settings.instanceId) {
      const instance = await tx.xboardInstance.findUnique({ where: { id: settings.instanceId } })
      if (!instance || instance.origin !== new URL(settings.url).origin) throw badRequest('Xboard 实例不存在或站点不匹配；更换站点必须创建新的实例身份')
    }
    if (row.activeRevisionId) return null
    const legacy = await tx.integrationConfig.findUnique({ where: { key: FAKA_LEGACY_KEY } })
    if (legacy?.activeRevisionId) return legacy.activeRevisionId
    const [tasks, operations] = await Promise.all([
      tx.fakaBridgeTask.count({ where: { configRevisionId: null } }),
      tx.xboardTrafficResetOperation.count({ where: { configRevisionId: null } }),
    ])
    const parsed = fakaSettingsSchema.safeParse(fakaPublicBootstrap()), bootstrap = fakaBootstrap()
    if ((tasks || operations) && (!parsed.success || !bootstrap.bridge.secret || !legacyConfirmed)) throw badRequest('存在历史履约。请先确认当前部署配置确为历史任务原目标；缺少可信配置时不能切换')
    if (!parsed.success || !bootstrap.bridge.secret) return null
    const id = randomUUID()
    await tx.integrationConfigRevision.create({ data: { id, key: FAKA_KEY, settings: parsed.data,
      credentialsCiphertext: encryptIntegrationCredentials(FAKA_KEY, id, parsed.data, { secret: bootstrap.bridge.secret }), createdBy: actor } })
    await tx.integrationConfig.create({ data: { key: FAKA_LEGACY_KEY, activeRevisionId: id, updatedBy: actor } })
    await tx.adminLog.create({ data: { adminUserId: actor, action: 'integration.legacy.capture', targetType: 'integrationConfig',
      detail: JSON.stringify({ service: FAKA_KEY, tasks, operations, revisionId: id, confirmed: legacyConfirmed }) } })
    return id
  },
})
