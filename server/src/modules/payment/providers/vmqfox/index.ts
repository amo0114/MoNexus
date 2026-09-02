import type { PaymentProvider } from '../types.js'
import { loadVmqfoxConfigFromEnv } from './config.js'
import { createDisabledVmqfoxProvider, createVmqfoxProvider } from './provider.js'

export {
  amountMinorToYuanString,
  yuanStringToAmountMinor,
  VMQFOX_YUAN_SCALE,
} from './amount.js'
export {
  VMQFOX_CAPABILITY_VERSION,
  VMQFOX_DEFAULT_ACCOUNT_KEY,
  VMQFOX_ORIGIN_ALLOWLIST,
  VMQFOX_PAYMENT_METHODS,
  VMQFOX_PAY_TYPE,
  VMQFOX_PROVIDER_NAME,
  VMQFOX_RECOMMENDED_ORIGIN,
  VMQFOX_WEBHOOK_PATH,
  isAllowedCheckoutRedirect,
  isVmqfoxPaymentMethod,
  loadVmqfoxConfigFromEnv,
  parseVmqfoxBaseUrl,
  type VmqfoxAdapterConfig,
  type VmqfoxPaymentMethod,
} from './config.js'
export { validateVmqfoxPayUrl, VMQFOX_PAY_URL_MAX_CHARS } from './payUrl.js'
export {
  callbackSignV2,
  createSignV2,
  queryByPayIdSignV2,
  signaturesEqual,
} from './sign.js'
export { mapVmqfoxState } from './normalize.js'
export {
  parseFormUrlEncoded,
  verifyAndNormalizeNotify,
  vmqfoxPaidDedupeKey,
  VMQFOX_WEBHOOK_FAILURE_BODY,
  VMQFOX_WEBHOOK_SUCCESS_BODY,
} from './webhook.js'
export { createVmqfoxApi, defaultVmqfoxHttp, VmqfoxClientError } from './client.js'
export { createDisabledVmqfoxProvider, createVmqfoxProvider } from './provider.js'

export function createVmqfoxProviderFromEnv(): PaymentProvider {
  const config = loadVmqfoxConfigFromEnv()
  if (!config) return createDisabledVmqfoxProvider()
  return createVmqfoxProvider(config)
}

/** Missing credentials stay disabled. Default VMQFOX_MODE is disabled. */
export const vmqfoxProvider: PaymentProvider = createVmqfoxProviderFromEnv()
