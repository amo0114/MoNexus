import type { Prisma } from '@prisma/client'
import type { CancellationAssessment, CheckoutExtension, FulfillmentProvider } from '../../extension-contracts/fulfillment.js'
import { getFulfillmentProvider, listFulfillmentProviders } from './registry.js'

type Tx = Prisma.TransactionClient

/**
 * Every refund path calls this in its transaction so callers never need to know
 * which provider (if any) owns remote work for the order.
 */
export async function onOrderRefundedInTx(tx: Tx, orderId: number): Promise<void> {
  for (const provider of listFulfillmentProviders()) {
    await provider.onOrderRefundedInTx(tx, orderId)
  }
}

export async function afterOrderRefunded(orderId: number): Promise<void> {
  for (const provider of listFulfillmentProviders()) {
    await provider.afterOrderRefunded?.(orderId)
  }
}

/**
 * Verdicts of every provider that owns work for the order (Order locked by the
 * caller). Providers that own work but cannot assess are reported by id so the
 * caller can answer `unsupported` instead of assuming nothing was dispatched.
 */
export async function assessProviderCancellationsInTx(
  tx: Tx,
  orderId: number,
): Promise<{ verdicts: CancellationAssessment[]; assessedProviderIds: string[] }> {
  const verdicts: CancellationAssessment[] = []
  const assessedProviderIds: string[] = []
  for (const provider of listFulfillmentProviders()) {
    const verdict = await provider.assessCancellationInTx?.(tx, orderId)
    if (verdict == null) continue
    verdicts.push(verdict)
    assessedProviderIds.push(provider.id)
  }
  return { verdicts, assessedProviderIds }
}

export async function afterCancellationAssessed(orderId: number): Promise<void> {
  for (const provider of listFulfillmentProviders()) {
    await provider.afterCancellationAssessed?.(orderId)
  }
}

export async function onOrderStatusChangedInTx(tx: Tx, orderId: number, toStatus: string): Promise<void> {
  for (const provider of listFulfillmentProviders()) {
    await provider.onOrderStatusChangedInTx?.(tx, orderId, toStatus)
  }
}

/** The provider that sells an Offer bound to `externalIntegration`, if it can. */
export function checkoutProviderFor(
  externalIntegration: string | null | undefined
): (FulfillmentProvider & { checkout: CheckoutExtension }) | null {
  if (!externalIntegration) return null
  const provider = getFulfillmentProvider(externalIntegration)
  return provider?.checkout ? (provider as FulfillmentProvider & { checkout: CheckoutExtension }) : null
}

/** True when the input carries any value (undefined/empty keys do not count). */
export function hasExtensionInput(input: Record<string, unknown>): boolean {
  return Object.values(input).some(value => value !== undefined && value !== null && value !== '')
}

/** Providers an Offer may be bound to, for admin product forms. */
export function listSellableProviders(): Array<{ id: string; label: string }> {
  return listFulfillmentProviders()
    .filter(provider => provider.checkout)
    .map(provider => ({ id: provider.id, label: provider.label }))
}

export async function isProvisionPending(orderId: number): Promise<boolean> {
  for (const provider of listFulfillmentProviders()) {
    if (await provider.isProvisionPending?.(orderId)) return true
  }
  return false
}

export function startFulfillmentBackgroundJobs(): void {
  for (const provider of listFulfillmentProviders()) provider.startBackgroundJobs?.()
}

export async function stopFulfillmentBackgroundJobs(): Promise<void> {
  await Promise.all(listFulfillmentProviders().map(provider => provider.stopBackgroundJobs?.()))
}
