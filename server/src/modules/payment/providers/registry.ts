import { config } from '../../../config/index.js'
import { paymentProviderUnavailable } from '../../../lib/httpError.js'
import { shouldLoadHistoricalAdapter } from '../../recharge/config.js'
import type { PaymentProviderName } from '../../recharge/types.js'
import { simulatorProvider } from './simulator/index.js'
import type { PaymentProvider } from './types.js'

const adapters: Partial<Record<PaymentProviderName, PaymentProvider>> = {
  simulator: simulatorProvider,
}

export function getRegisteredProvider(name: PaymentProviderName): PaymentProvider | undefined {
  if (!shouldLoadHistoricalAdapter(name, config.recharge.registeredProviders, config.recharge.enabledProviders)) {
    return undefined
  }
  return adapters[name]
}

export function getEnabledProvider(name: PaymentProviderName): PaymentProvider {
  if (!config.recharge.enabledProviders.includes(name)) {
    throw paymentProviderUnavailable()
  }
  const provider = adapters[name]
  if (!provider) throw paymentProviderUnavailable()
  return provider
}

/** Historical close/query/complete/refund stay loaded from the registered set. */
export function getHistoricalProvider(name: PaymentProviderName): PaymentProvider {
  const provider = getRegisteredProvider(name)
  if (!provider) throw paymentProviderUnavailable()
  return provider
}

export function listEnabledProviders(): PaymentProvider[] {
  return config.recharge.enabledProviders
    .map(name => adapters[name])
    .filter((provider): provider is PaymentProvider => provider != null)
}

export function listRegisteredProviderNames(): PaymentProviderName[] {
  return [...config.recharge.registeredProviders]
}
