import { isDeepStrictEqual } from 'node:util'
import { badRequest } from '../../lib/httpError.js'
import { managedIntegration } from './managedIntegration.js'
import { paymentIntegrationKey } from '../payment/providers/runtime.js'
import { paymentAccountIdentity, paymentDestination, runtimeWebhookUrl, paymentSettingsSchema, paymentCredentialsSchema, RUNTIME_PAYMENT_NAMES, validateRuntimePayment, type RuntimePaymentName } from '../payment/providers/runtimeConfig.js'
import { Router } from 'express'
export const paymentSettingsRoutes = Router()
export function paymentSettingsDefinition(name: RuntimePaymentName) {
  return managedIntegration({ key: paymentIntegrationKey(name),
    settings: paymentSettingsSchema.refine(s => s.provider === name, '支付渠道不匹配'),
    credentials: paymentCredentialsSchema.refine(c => c.provider === name, '支付凭据渠道不匹配'),
    bootstrap: () => null,
    sameDestination: (a, b) => paymentDestination(a) === paymentDestination(b),
    testKind: name === 'stripe' ? 'read_only' : 'local_validation',
    test: validateRuntimePayment,
    accountIdForRevision: async (tx, settings) => (await tx.paymentRuntimeAccount.findUniqueOrThrow({ where: { provider_providerAccountKey: { provider: name, providerAccountKey: paymentAccountIdentity(settings).providerAccountKey } } })).id,
    publicDetails: draft => {
      if (!draft) return { draftWebhookUrl: null, draftAccountKey: null }
      try { return { draftWebhookUrl: runtimeWebhookUrl(draft), draftAccountKey: paymentAccountIdentity(draft).providerAccountKey } }
      catch { return { draftWebhookUrl: null, draftAccountKey: paymentAccountIdentity(draft).providerAccountKey } }
    },
    beforeActivate: async (tx, _row, settings) => {
      const account = paymentAccountIdentity(settings)
      const existing = await tx.paymentRuntimeAccount.findUnique({ where: { provider_providerAccountKey: { provider: name, providerAccountKey: account.providerAccountKey } } })
      if (existing && (existing.environment !== account.environment || !isDeepStrictEqual(existing.identity, account.identity))) throw badRequest('已有支付账号身份不可更改；请创建新的商户账号配置')
      const retained = existing ? await tx.integrationConfigRevision.count({ where: { paymentAccountId: existing.id } }) : 0
      if (retained >= 8) throw badRequest('该账号已保留 8 个凭据版本；为保证迟到回调可验证，暂不能继续增加版本')
      if (!existing) await tx.paymentRuntimeAccount.create({ data: { provider: name, ...account } })
      return null
    },
  })
}
for (const name of RUNTIME_PAYMENT_NAMES) paymentSettingsRoutes.use(`/integrations/payments/${name}/config`, paymentSettingsDefinition(name).router)
