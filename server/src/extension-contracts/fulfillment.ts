import type { Offer, Prisma } from '@prisma/client'
import type { StructuredDeliveryContent } from '../lib/deliveryFields.js'
import type { PurchaseFormField } from '../lib/purchaseForm.js'

type Tx = Prisma.TransactionClient

/**
 * Provider-specific purchase input (account choice, target version, ...).
 * Validated only by the provider bound to the server-side Offer; a client can
 * never pick the executor by sending another provider's input.
 */
export type ExtensionInput = Record<string, unknown>

export type CheckoutPreviewExtension = {
  unpurchasableReason?: string
  /** Extra preview fields merged into the checkout preview response. */
  fields?: Record<string, unknown>
}

/**
 * Purchase steps owned by a provider. The order core keeps price, stock,
 * points, idempotency and Offer/Product locks; it calls these at fixed points.
 */
export interface CheckoutExtension<Prepared = unknown, Target = unknown> {
  /** Read-only preview additions; no locks, no writes. */
  preview?(input: { userId: number; offer: Offer; extensionInput: ExtensionInput }): Promise<CheckoutPreviewExtension>
  /** Purchase-form fields the buyer actually answers for this offer. */
  formFields?(offer: Offer, fields: PurchaseFormField[]): PurchaseFormField[]
  /** Outside any transaction: remote eligibility, ownership proofs, capacity. Throw HttpError to reject. */
  prepare(input: {
    userId: number
    offer: Offer
    purchaseForm: PurchaseFormField[]
    formAnswers?: Record<string, string>
    extensionInput: ExtensionInput
    idempotencyKey?: string
    renewalOfOrderId?: number
  }): Promise<Prepared>
  /**
   * In the order transaction, before any debit: re-validate local state and
   * return the frozen target. Local reads only; never call the network here.
   */
  validateInTx(tx: Tx, input: {
    userId: number
    offer: Offer
    prepared: Prepared
    purchaseFormAnswers: Record<string, string> | null
    formAnswers?: Record<string, string>
  }): Promise<Target>
  /**
   * In the order transaction after the Order row exists: lock and re-check the
   * Offer binding, then insert the durable task. Returns a post-commit kick.
   */
  createTaskInTx(tx: Tx, input: { orderId: number; offer: Offer; target: Target }): Promise<() => void>
}

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
  /** Operator-facing name shown in admin product forms. */
  readonly label: string
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
  /** Present when Offers may name this provider in `externalIntegration`. */
  checkout?: CheckoutExtension
  /** Whether the buyer-visible order still waits for this provider (idempotent replay). */
  isProvisionPending?(orderId: number): Promise<boolean>
  startBackgroundJobs?(): void
  /** Stop producing work; resolves once in-flight jobs finish (awaited before DB shutdown). */
  stopBackgroundJobs?(): void | Promise<void>
}

/**
 * What a provider observed about one remote operation. A timeout, transport
 * error or "not found" is never proof that nothing happened remotely: only the
 * two `*_effect` kinds let the core refund held points.
 */
export type RemoteObservation =
  | {
      kind: 'succeeded'
      delivery: {
        content: string
        structuredContent?: StructuredDeliveryContent | null
        /** Omit to use the Offer's validity projection; null = never expires. */
        expiresAt?: Date | null
      }
      /** Non-secret proof kept on the job (remote ids, timestamps). */
      evidence?: Record<string, unknown>
    }
  | { kind: 'processing'; retryAfterMs?: number }
  | { kind: 'unknown'; code: string }
  | { kind: 'not_found' }
  /** The provider guarantees the effect neither happened nor can happen later. */
  | { kind: 'failed_without_effect'; code: string }
  /** A durable remote cancellation blocks any later execution. */
  | { kind: 'cancelled_before_effect' }

/** Frozen at order time; retries never change any field. */
export type FulfillmentCommand = {
  providerId: string
  /** Stable idempotency key; the same key must never perform the effect twice. */
  operationKey: string
  orderId: number
  sku: string
  input: Record<string, unknown>
}

/**
 * The minimal adapter for a provider that uses the core job engine
 * (`modules/fulfillment/jobProvider.ts`): durable job, lease, retry, reconcile,
 * refund coordination and result application come from the core.
 */
export interface ExternalFulfillmentAdapter {
  readonly id: string
  readonly label: string
  /** False blocks new purchases; existing jobs keep converging. */
  isConfigured(): boolean
  /**
   * Outside any transaction, before the order: validate provider input and the
   * buyer, return the input frozen on the job.
   */
  prepare?(input: { userId: number; offer: Offer; extensionInput: ExtensionInput }): Promise<Record<string, unknown>>
  execute(command: FulfillmentCommand): Promise<RemoteObservation>
  query(command: FulfillmentCommand): Promise<RemoteObservation>
  /** Durably block the operation if it has not run. Omit when the remote cannot guarantee that. */
  cancel?(command: FulfillmentCommand): Promise<RemoteObservation>
}
