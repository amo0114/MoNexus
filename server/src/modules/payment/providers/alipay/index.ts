import type { PaymentProvider } from '../types.js'
import { loadAlipayConfigFromEnv } from './config.js'
import { createAlipayProvider, createDisabledAlipayProvider } from './provider.js'

export {
  amountMinorToYuanString,
  isFullRefundAmount,
  yuanStringToAmountMinor,
  ALIPAY_YUAN_SCALE,
} from './amount.js'
export {
  ALIPAY_CAPABILITY_VERSION,
  ALIPAY_LIVE_GATEWAY,
  ALIPAY_LIVE_HOSTS,
  ALIPAY_PAYMENT_METHODS,
  ALIPAY_PROVIDER_NAME,
  ALIPAY_SANDBOX_GATEWAY,
  ALIPAY_SANDBOX_HOSTS,
  alipayAccountKey,
  assertAlipayEnvironmentIsolation,
  formPostHostsFor,
  loadAlipayConfigFromEnv,
  type AlipayAdapterConfig,
  type AlipayPaymentMethod,
} from './config.js'
export { createOfficialAlipaySdk, structuredFormPostFromSignedUrl, type AlipaySdkSurface } from './gateway.js'
export { notifyDedupeKey, parseFormUrlEncoded, verifyAndNormalizeNotify } from './notify.js'
export { createAlipayProvider, createDisabledAlipayProvider } from './provider.js'

export function createAlipayProviderFromEnv(): PaymentProvider {
  const config = loadAlipayConfigFromEnv()
  if (!config) return createDisabledAlipayProvider()
  return createAlipayProvider(config)
}

/** PR-F mounts this export. Missing credentials stay disabled. */
export const alipayProvider: PaymentProvider = createAlipayProviderFromEnv()
