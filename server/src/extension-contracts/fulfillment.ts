import type { Prisma } from '@prisma/client'

type Tx = Prisma.TransactionClient

/**
 * Plugs an external fulfillment system into the order core. Core owns order
 * status, points and settlement; a provider owns its task tables, remote
 * protocol and evidence, and never writes points or settlement itself (it uses
 * `modules/fulfillment/apply.ts`).
 *
 * Hooks run for every registered provider, so each must ignore orders it has
 * no task for. Providers are trusted in-process code registered at build time
 * in `bootstrap/extensions.ts`.
 */
export interface FulfillmentProvider {
  /** Stable id; equals `Offer.externalIntegration` for offers it fulfills. */
  readonly id: string
  /**
   * Inside the transaction that refunds the order; Order is already locked
   * (lock order: Order → provider task). Cancel undispatched work or queue a
   * remote cancellation; never assume a timeout means nothing happened.
   */
  onOrderRefundedInTx(tx: Tx, orderId: number): Promise<void>
  /** After the refund commits: kick any remote cancellation queued above. */
  afterOrderRefunded?(orderId: number): Promise<void>
  /** Inside every order status transition, for provider-owned synchronous side effects. */
  onOrderStatusChangedInTx?(tx: Tx, orderId: number, toStatus: string): Promise<void>
  startBackgroundJobs?(): void
  /** Stop producing work; resolves once in-flight jobs finish (awaited before DB shutdown). */
  stopBackgroundJobs?(): void | Promise<void>
}
