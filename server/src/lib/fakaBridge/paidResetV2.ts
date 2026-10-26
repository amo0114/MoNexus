import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { callFakaV2 } from './accountV2.js'

const uuid = z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/)
const id = z.string().regex(/^[1-9][0-9]{0,18}$/).refine(v => v.length < 19 || v <= '9223372036854775807')
const planId = z.string().regex(/^[1-9][0-9]{0,9}$/).refine(v => v.length < 10 || v <= '2147483647')
const decimal = z.string().regex(/^(0|[1-9][0-9]{0,18})$/).refine(v => v.length < 19 || v <= '9223372036854775807')
const sku = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,127}$/)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const client = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/)
const reason = z.enum(['SUBSCRIPTION_INELIGIBLE', 'RESET_NOT_FOR_SALE', 'ACCOUNT_NOT_FOUND'])
const envelope = z.object({ success: z.literal(true), protocol_version: z.literal(2), request_id: uuid, queried_at: z.string().datetime() })
const previewInput = z.object({ user_id: id, sku, expected_plan_id: planId }).strict()
const previewSchema = envelope.extend({ preview: z.object({ user_id: id, sku, plan_id: planId,
  period: z.literal('reset_traffic'), eligible: z.boolean(), block_reason: reason.nullable() }).strict() }).strict()

export const paidResetPayloadSchema = previewInput.extend({
  order_no: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), period: z.literal('reset_traffic'),
}).strict()
export type PaidResetPayload = z.infer<typeof paidResetPayloadSchema>
const snapshot = z.object({ plan_id: planId, transfer_enable: decimal, expired_at: decimal.nullable(),
  last_reset_at: decimal.nullable(), reset_count: decimal, next_reset_at: decimal.nullable(), u: decimal, d: decimal }).strict()
const operation = z.object({ order_no: paidResetPayloadSchema.shape.order_no, user_id: id, sku, plan_id: planId,
  period: z.literal('reset_traffic'), payload_hash: hash, status: z.enum(['not_found', 'pending', 'completed', 'failed', 'revoked']),
  trade_no: z.string().min(1).max(64).nullable(), error_code: reason.nullable(),
  before: snapshot.nullable(), after: snapshot.nullable(), completed_at: z.string().datetime().nullable(),
}).strict().refine(op => {
  // A refund can retain a committed execution. It must retain the same proof as
  // completed; a pre-execution tombstone has no trade or invented snapshots.
  const evidence = op.before !== null || op.after !== null || op.trade_no !== null || op.completed_at !== null
  if (op.status === 'completed' || op.status === 'revoked' && evidence) {
    const before = op.before, after = op.after
    return before !== null && after !== null && op.trade_no !== null && op.completed_at !== null && op.error_code === null
      && before.plan_id === op.plan_id && after.plan_id === before.plan_id && after.transfer_enable === before.transfer_enable
      && after.expired_at === before.expired_at && after.u === '0' && after.d === '0'
      // Refinements can run on a dirty regex result: do not BigInt invalid text.
      && /^[0-9]+$/.test(after.reset_count) && /^[0-9]+$/.test(before.reset_count)
      && BigInt(after.reset_count) === BigInt(before.reset_count) + 1n
  }
  if (evidence) return false
  return op.status === 'failed' ? op.error_code !== null : op.error_code === null
})
export const paidResetResultSchema = envelope.extend({ operation }).strict()
export type PaidResetResult = z.infer<typeof operation>
/** Re-validate persisted proof against immutable task identity; no remote/config dependency. */
export function verifiedPaidExecution(value: unknown, payload: PaidResetPayload, clientId: string): PaidResetResult | null {
  if (!paidResetPayloadSchema.safeParse(payload).success || !client.safeParse(clientId).success) return null
  const parsed = operation.safeParse(value)
  if (!parsed.success) return null
  const op = parsed.data
  return (op.status === 'completed' || op.status === 'revoked') && op.after !== null
    && op.order_no === payload.order_no && op.user_id === payload.user_id && op.sku === payload.sku
    && op.plan_id === payload.expected_plan_id && op.payload_hash === paidResetPayloadHash(payload, clientId) ? op : null
}
export function paidResetPayloadHash(p: PaidResetPayload, clientId: string): string {
  return createHash('sha256').update(JSON.stringify(['paid_reset_v1', clientId, p.order_no, p.user_id, p.sku, p.expected_plan_id, p.period])).digest('hex')
}

type Options = Parameters<typeof callFakaV2>[4]
export async function callPaidResetPreview(input: z.infer<typeof previewInput>, options: Options = {}) {
  if (!previewInput.safeParse(input).success) return { ok: false as const, code: 'INVALID_REQUEST' as const, httpStatus: 0 }
  const requestId = randomUUID()
  return callFakaV2('paid-reset-preview', { user_id: input.user_id, sku: input.sku }, previewSchema,
    b => b.request_id === requestId && b.preview.user_id === input.user_id && b.preview.sku === input.sku
      && b.preview.plan_id === input.expected_plan_id && b.preview.eligible === (b.preview.block_reason === null), options, requestId)
}

/** The caller must freeze clientId with the commercial task, just like the target. */
export async function callPaidReset(action: 'paid-reset' | 'paid-reset-status' | 'paid-reset-revoke',
  payload: PaidResetPayload, clientId: string, options: Options = {}) {
  if (!paidResetPayloadSchema.safeParse(payload).success || !client.safeParse(clientId).success) {
    return { ok: false as const, code: 'INVALID_REQUEST' as const, httpStatus: 0 }
  }
  const requestId = randomUUID(), expectedHash = paidResetPayloadHash(payload, clientId)
  return callFakaV2(action, payload, paidResetResultSchema,
    b => b.request_id === requestId && b.operation.order_no === payload.order_no && b.operation.user_id === payload.user_id
      && b.operation.sku === payload.sku && b.operation.plan_id === payload.expected_plan_id && b.operation.payload_hash === expectedHash
      && (action === 'paid-reset-status' || action === 'paid-reset-revoke' && b.operation.status === 'revoked'
        || action === 'paid-reset' && ['completed', 'failed', 'revoked'].includes(b.operation.status)),
    options, requestId)
}
