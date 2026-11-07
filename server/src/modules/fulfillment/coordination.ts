import type { Prisma } from '@prisma/client'
import { listFulfillmentProviders } from './registry.js'

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

export async function onOrderStatusChangedInTx(tx: Tx, orderId: number, toStatus: string): Promise<void> {
  for (const provider of listFulfillmentProviders()) {
    await provider.onOrderStatusChangedInTx?.(tx, orderId, toStatus)
  }
}

export function startFulfillmentBackgroundJobs(): void {
  for (const provider of listFulfillmentProviders()) provider.startBackgroundJobs?.()
}

export async function stopFulfillmentBackgroundJobs(): Promise<void> {
  await Promise.all(listFulfillmentProviders().map(provider => provider.stopBackgroundJobs?.()))
}
