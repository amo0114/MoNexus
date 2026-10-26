import { config } from '../../config/index.js'
import { FAKA_PROVISION_EMAIL_KEYS } from './provisionEmail.js'

export function paidResetPlanId(sku: string | null | undefined): string | null {
  const match = /^plan-([1-9][0-9]{0,9})-(?:reset_traffic|reset_price)$/.exec((sku ?? '').trim().toLowerCase())
  return match && BigInt(match[1]) <= 2147483647n ? match[1] : null
}
export function usesStablePaidReset(offer: { externalIntegration?: string | null; externalSku?: string | null }): boolean {
  return config.xboardAccounts.paidResetEnabled && offer.externalIntegration === 'faka_bridge' && paidResetPlanId(offer.externalSku) !== null
}
export function withoutProvisionEmail<T extends { key: string }>(fields: T[]): T[] {
  return fields.filter(f => !(FAKA_PROVISION_EMAIL_KEYS as readonly string[]).includes(f.key))
}
