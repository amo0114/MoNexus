import type { IntegrationConfigRevision, Prisma } from '@prisma/client'
import { prisma } from '../../../lib/prisma.js'
import { paymentProviderUnavailable } from '../../../lib/httpError.js'
import { decryptIntegrationCredentials } from '../../../lib/runtimeSettings/credentials.js'
import { config } from '../../../config/index.js'
import { buildRuntimePaymentProvider, paymentAccountIdentity, paymentSettingsSchema, paymentCredentialsSchema, type RuntimePaymentName } from './runtimeConfig.js'
import type { PaymentProviderName } from '../../recharge/types.js'
import type { PaymentProvider } from './types.js'
export const paymentIntegrationKey = (name: string) => `payment:${name}`
const clients = new Map<string, PaymentProvider>()
export function decodePaymentRevision(row: IntegrationConfigRevision) {
  try {
    const settings = paymentSettingsSchema.parse(row.settings)
    if (row.key !== paymentIntegrationKey(settings.provider) || !row.credentialsCiphertext) throw new Error()
    const credentials = paymentCredentialsSchema.parse(decryptIntegrationCredentials(row.key, row.id, settings, row.credentialsCiphertext))
    let provider = clients.get(row.id)
    if (!provider) {
      provider = buildRuntimePaymentProvider(settings, credentials)
      if (clients.size >= 32) clients.delete(clients.keys().next().value!)
      clients.set(row.id, provider)
    }
    return { provider, revisionId: row.id, settings, ...paymentAccountIdentity(settings) }
  } catch { throw paymentProviderUnavailable('支付配置凭据不可用，请恢复对应加密密钥') }
}
type Db = Pick<Prisma.TransactionClient, 'integrationConfig' | 'integrationConfigRevision'>
export async function runtimePaymentSelection(name: PaymentProviderName, db: Db = prisma) {
  const state = await db.integrationConfig.findUnique({ where: { key: paymentIntegrationKey(name) }, include: { activeRevision: true } })
  if (state && !state.enabled) throw paymentProviderUnavailable('该渠道已停止接受新订单')
  if (!state?.activeRevisionId) return null
  const selected = decodePaymentRevision(state.activeRevision!)
  if (selected.settings.provider !== name || selected.environment !== (config.recharge.mode === 'live' ? 'live' : 'sandbox')) throw paymentProviderUnavailable('支付账号与部署环境不匹配')
  return selected
}
export async function paymentRevision(name: PaymentProviderName, revisionId: string) {
  const row = await prisma.integrationConfigRevision.findUnique({ where: { id: revisionId } })
  if (!row || row.key !== paymentIntegrationKey(name)) throw paymentProviderUnavailable('支付配置版本不存在')
  return decodePaymentRevision(row)
}
export async function paymentRevisionEnvironment(revisionId?: string | null): Promise<'live' | 'sandbox'> {
  if (!revisionId) return config.recharge.mode === 'live' ? 'live' : 'sandbox'
  const row = await prisma.integrationConfigRevision.findUnique({ where: { id: revisionId } })
  if (!row) throw paymentProviderUnavailable()
  return decodePaymentRevision(row).environment
}
export async function runtimePaymentNames() {
  const rows = await prisma.integrationConfig.findMany({ where: { key: { startsWith: 'payment:' }, activeRevisionId: { not: null }, enabled: true }, select: { key: true } })
  return rows.map(row => row.key.slice('payment:'.length) as RuntimePaymentName)
}
/** Bounded verification set. Activation refuses a ninth retained revision for one physical account. */
export async function paymentWebhookCandidates(name: RuntimePaymentName, accountKey: string) {
  const account = await prisma.paymentRuntimeAccount.findUnique({ where: { provider_providerAccountKey: { provider: name, providerAccountKey: accountKey } } })
  if (!account) throw paymentProviderUnavailable()
  const candidates = await prisma.integrationConfigRevision.findMany({ where: { key: paymentIntegrationKey(name), paymentAccountId: account.id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 9 })
  if (!candidates.length || candidates.length > 8) throw paymentProviderUnavailable('回调验签版本集合不可用')
  return candidates.map(decodePaymentRevision)
}

/** An operator may reconcile an inactive account without enabling new payments. */
export async function reconciliationPaymentSelection(name: PaymentProviderName, accountKey?: string) {
  if (!accountKey) {
    const state = await prisma.integrationConfig.findUnique({ where: { key: paymentIntegrationKey(name) }, include: { activeRevision: true } })
    return state?.activeRevision ? decodePaymentRevision(state.activeRevision) : null
  }
  const account = await prisma.paymentRuntimeAccount.findUnique({ where: { provider_providerAccountKey: { provider: name, providerAccountKey: accountKey } } })
  if (!account) return null
  const row = await prisma.integrationConfigRevision.findFirst({ where: { key: paymentIntegrationKey(name), paymentAccountId: account.id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] })
  if (!row) throw paymentProviderUnavailable()
  return decodePaymentRevision(row)
}
