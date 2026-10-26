import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { callFakaV2 } from './accountV2.js'

const uuid = z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/)
const id = z.string().regex(/^[1-9][0-9]{0,18}$/).refine(v => v.length < 19 || v <= '9223372036854775807')
const decimal = z.string().regex(/^(0|[1-9][0-9]{0,18})$/).refine(v => v.length < 19 || v <= '9223372036854775807')
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const base = z.object({ success: z.literal(true), protocol_version: z.literal(2), request_id: uuid, queried_at: z.string().datetime() })
const reason = z.enum(['SUBSCRIPTION_INELIGIBLE','SUBSCRIPTION_CHANGED','NOTHING_TO_RESET','ACCOUNT_NOT_FOUND','BENEFIT_ALREADY_CONSUMED','CANCELLED'])
const snapshot = z.object({ plan_id: id.nullable(), transfer_enable: decimal, expired_at: decimal.nullable(),
  last_reset_at: decimal.nullable(), reset_count: decimal, next_reset_at: decimal.nullable(), u: decimal, d: decimal }).strict()
const previewSchema = base.extend({ preview: z.object({ user_id: id, plan_id: id.nullable(), fingerprint: hash,
  eligible: z.boolean(), block_reason: reason.nullable(), snapshot }).strict() }).strict()
export const resetPayloadSchema = z.object({ operation_id: uuid, actor_ref: id, user_id: id,
  benefit_code: z.literal('welcome_traffic_reset_v1'), expected_plan_id: id, subscription_fingerprint: hash }).strict()
export type ResetPayload = z.infer<typeof resetPayloadSchema>
export const resetResultSchema = base.extend({ operation: z.object({ operation_id: uuid, payload_hash: hash,
  status: z.enum(['not_found','succeeded','failed','cancelled']), error_code: reason.nullable(), before: snapshot.nullable(), after: snapshot.nullable(),
  completed_at: z.string().datetime().nullable() }).strict().refine(op => {
    if (op.status === 'succeeded') return op.before !== null && op.after !== null && op.completed_at !== null && op.error_code === null
      && op.after.u === '0' && op.after.d === '0' && op.after.plan_id === op.before.plan_id && op.after.transfer_enable === op.before.transfer_enable
      && op.after.expired_at === op.before.expired_at && /^[0-9]+$/.test(op.after.reset_count) && /^[0-9]+$/.test(op.before.reset_count)
      && BigInt(op.after.reset_count) === BigInt(op.before.reset_count) + 1n
    if (op.status === 'not_found') return op.before === null && op.after === null && op.completed_at === null && op.error_code === null
    return op.before === null && op.after === null && op.completed_at !== null && op.error_code !== null
  }) }).strict()
export type ResetResult = z.infer<typeof resetResultSchema>['operation']
export function resetPayloadHash(p: ResetPayload) {
  return createHash('sha256').update(JSON.stringify([p.operation_id,p.actor_ref,p.user_id,p.benefit_code,p.expected_plan_id,p.subscription_fingerprint])).digest('hex')
}

export async function callResetPreview(userId: string, options: Parameters<typeof callFakaV2>[4] = {}) {
  if (!id.safeParse(userId).success) return { ok: false as const, code: 'INVALID_REQUEST' as const, httpStatus: 0 }
  const requestId = randomUUID()
  return callFakaV2('traffic-reset-preview', { request_id: requestId, user_id: userId }, previewSchema,
    b => b.request_id === requestId && b.preview.user_id === userId && b.preview.plan_id === b.preview.snapshot.plan_id
      && b.preview.eligible === (b.preview.block_reason === null), options, requestId)
}
export async function callTrafficReset(action: 'traffic-reset' | 'traffic-reset-status' | 'traffic-reset-cancel', payload: ResetPayload, options: Parameters<typeof callFakaV2>[4] = {}) {
  if (!resetPayloadSchema.safeParse(payload).success) return { ok: false as const, code: 'INVALID_REQUEST' as const, httpStatus: 0 }
  const requestId = randomUUID(), expectedHash = resetPayloadHash(payload)
  return callFakaV2(action, { request_id: requestId, ...payload }, resetResultSchema,
    b => b.request_id === requestId && b.operation.operation_id === payload.operation_id && b.operation.payload_hash === expectedHash, options, requestId)
}
