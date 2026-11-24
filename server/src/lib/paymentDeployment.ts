import type { PaymentProviderName } from './paymentTypes.js'

export function isProductionDeploy(nodeEnv: string, deployEnv?: string): boolean {
  const deploymentEnv = deployEnv ?? 'production'
  return nodeEnv === 'production' && deploymentEnv === 'production'
}

export function shouldLoadHistoricalAdapter(
  name: PaymentProviderName,
  registered: readonly PaymentProviderName[],
  _enabled: readonly PaymentProviderName[],
): boolean {
  return registered.includes(name)
}
