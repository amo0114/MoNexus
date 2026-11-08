import type { FulfillmentProvider } from '../../extension-contracts/fulfillment.js'

const providers = new Map<string, FulfillmentProvider>()

export function registerFulfillmentProvider(provider: FulfillmentProvider): void {
  const existing = providers.get(provider.id)
  if (existing && existing !== provider) {
    throw new Error(`Fulfillment provider already registered: ${provider.id}`)
  }
  providers.set(provider.id, provider)
}

export function getFulfillmentProvider(id: string): FulfillmentProvider | undefined {
  return providers.get(id)
}

export function listFulfillmentProviders(): FulfillmentProvider[] {
  return [...providers.values()]
}
