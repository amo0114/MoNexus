import { runtimePaymentSelection } from '../payment/providers/runtime.js'
import type { Prisma } from '@prisma/client'
import { paymentProviderUnavailable } from '../../lib/httpError.js'
import { getEnabledProvider } from '../payment/providers/registry.js'
import type { PaymentProvider, ProviderCapabilities } from '../payment/providers/types.js'
import { PAYMENT_PROVIDER_NAMES, type PaymentProviderName, type RechargeCurrency } from './types.js'
import { assertProviderEnabled, providerEnvironment } from './gates.js'

export function asProviderName(value: string): PaymentProviderName {
  if (!(PAYMENT_PROVIDER_NAMES as readonly string[]).includes(value)) {
    throw paymentProviderUnavailable()
  }
  return value as PaymentProviderName
}

export async function resolveCapabilities(input: {
  providerName: PaymentProviderName
  currency: RechargeCurrency
  paymentMethod: string
  db?: Prisma.TransactionClient
}): Promise<{ provider: PaymentProvider; accountKey: string; capabilities: ProviderCapabilities; revisionId: string | null }> {
  const runtime = await runtimePaymentSelection(input.providerName, input.db)
  if (!runtime) assertProviderEnabled(input.providerName)
  const provider = runtime?.provider ?? getEnabledProvider(input.providerName)
  const environment = runtime?.environment ?? providerEnvironment()
  const { providerAccountKey } = await provider.selectAccount({
    environment,
    currency: input.currency,
    paymentMethod: input.paymentMethod,
  })
  const capabilities = await provider.getCapabilities({
    providerAccountKey,
    environment,
    currency: input.currency,
    paymentMethod: input.paymentMethod,
  })
  if (!capabilities.supportedCurrencies.includes(input.currency)) {
    throw paymentProviderUnavailable()
  }
  if (!capabilities.paymentMethods.includes(input.paymentMethod)) {
    throw paymentProviderUnavailable()
  }
  return { provider, accountKey: providerAccountKey, capabilities, revisionId: runtime?.revisionId ?? null }
}
