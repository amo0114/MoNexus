import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { config } from '../../config/index.js'
import { prepareSignedJsonV2 } from '../signedProtocolV2.js'
import { defaultFakaTransport, type FakaBridgeClientOptions } from './client.js'

const uuid = z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/)
const uint = z.string().regex(/^(0|[1-9][0-9]{0,18})$/)
const id = z.string().regex(/^[1-9][0-9]{0,18}$/).refine(v => v.length < 19 || v <= '9223372036854775807')
const orderNo = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)
const account = z.object({ user_id: id, email: z.string().email().max(255) }).strict()
const envelope = z.object({
  success: z.literal(true), protocol_version: z.literal(2), request_id: uuid, queried_at: z.string().datetime(),
})
export const fakaV2CapabilitiesSchema = envelope.extend({
  plugin_version: z.string().regex(/^\d+\.\d+\.\d+$/), build_id: z.string().regex(/^[a-f0-9]{64}$/),
  core_adapter: z.literal('xboard-eloquent-read-v1'),
  capabilities: z.object({
    resolve_by_order: z.boolean(), subscription_by_user_id: z.boolean(),
    reset_idempotency: z.boolean(), reset_status: z.boolean(),
    cancel_tombstone: z.boolean(), paid_reset_by_user_id: z.boolean(),
  }).strict(),
}).strict()
const resolveSchema = envelope.extend({
  external_order_no: orderNo, trade_no: z.string().min(1).max(64),
  source_status: z.enum(['completed', 'revoked']), account,
}).strict()
const subscriptionSchema = envelope.extend({
  account,
  subscription: z.object({
    status: z.enum(['active', 'expired', 'no_plan', 'blocked']), plan_id: id.nullable(), plan_name: z.string().max(255).nullable(),
    total_bytes: uint, upload_bytes: uint, download_bytes: uint,
    used_bytes: z.string().regex(/^(0|[1-9][0-9]{0,19})$/), remaining_bytes: uint,
    expires_at: uint.nullable(), next_reset_at: uint.nullable(), reset_count: uint.nullable(),
  }).strict().refine(s => {
    // Zod refinements can run after a dirty regex result; never parse invalid
    // remote decimal text with BigInt or let a malformed DTO throw outward.
    if (![s.upload_bytes, s.download_bytes, s.total_bytes, s.used_bytes, s.remaining_bytes]
      .every(v => /^(0|[1-9][0-9]{0,19})$/.test(v))) return false
    const used = BigInt(s.upload_bytes) + BigInt(s.download_bytes)
    const remaining = BigInt(s.total_bytes) > used ? BigInt(s.total_bytes) - used : 0n
    return used === BigInt(s.used_bytes) && remaining === BigInt(s.remaining_bytes)
  }),
}).strict()

export type FakaV2Capabilities = z.infer<typeof fakaV2CapabilitiesSchema>
export type FakaV2ResolvedAccount = z.infer<typeof resolveSchema>
export type FakaV2Subscription = z.infer<typeof subscriptionSchema>
export type FakaV2FailureCode = 'NOT_CONFIGURED' | 'INVALID_REQUEST' | 'INVALID_TARGET' | 'TIMEOUT' | 'NETWORK' | 'HTTP' | 'INVALID_RESPONSE' | 'REMOTE_REJECTED'
export type FakaV2Result<T> = { ok: true; body: T; httpStatus: number }
  | { ok: false; code: FakaV2FailureCode; httpStatus: number; remoteCode?: string }
type Options = Pick<FakaBridgeClientOptions, 'url' | 'secret' | 'timeoutMs' | 'allowInsecureTargets' | 'transport'>
const remoteCodes = new Set(['SIGNATURE_INVALID', 'BODY_TOO_LARGE', 'CONTENT_TYPE_INVALID', 'REPLAY_STORE_UNAVAILABLE',
  'REQUEST_REPLAYED', 'REQUEST_INVALID', 'ACCOUNT_UNRESOLVED', 'ACCOUNT_NOT_FOUND', 'CAPABILITY_UNAVAILABLE', 'CORE_DATA_INVALID', 'BRIDGE_UNAVAILABLE', 'OPERATION_CONFLICT'])

/** Fixed server-configured origin only; never accepts a caller-controlled path or remote URL. */
function target(action: string, configuredUrl: string, allowInsecure: boolean): URL | null {
  try {
    const base = new URL(configuredUrl)
    if ((base.protocol !== 'https:' && !(allowInsecure && base.protocol === 'http:')) || base.username || base.password
      || base.search || base.hash || !/^\/plugin\/faka-bridge\/order-paid\/?$/.test(base.pathname)) return null
    return new URL(`/plugin/faka-bridge/v2/${action}`, base.origin)
  } catch { return null }
}

export async function callFakaV2<T>(action: string, input: Record<string, string>, schema: z.ZodType<T>,
  matches: (body: T) => boolean, options: Options, requestId: string): Promise<FakaV2Result<T>> {
  if (!uuid.safeParse(requestId).success) return { ok: false, code: 'INVALID_REQUEST', httpStatus: 0 }
  const url = options.url ?? config.fakaBridge.url
  const secret = options.secret ?? config.fakaBridge.secret
  if (!url || !secret) return { ok: false, code: 'NOT_CONFIGURED', httpStatus: 0 }
  const allowInsecure = options.allowInsecureTargets ?? config.fakaBridge.allowInsecureTargets
  const endpoint = target(action, url, allowInsecure)
  if (!endpoint) return { ok: false, code: 'INVALID_TARGET', httpStatus: 0 }
  const signed = prepareSignedJsonV2({ audience: 'xboard', path: endpoint.pathname, secret,
    body: { request_id: requestId, ...input } })
  const transport = options.transport ?? defaultFakaTransport(allowInsecure)
  let response: Awaited<ReturnType<typeof transport>>
  try {
    response = await transport({ method: 'POST', url: endpoint.toString(), body: signed.body,
      headers: { ...signed.headers, accept: 'application/json', 'content-length': String(Buffer.byteLength(signed.body)) },
      timeoutMs: options.timeoutMs ?? config.fakaBridge.timeoutMs })
  } catch (err) {
    return { ok: false, code: err instanceof Error && /timeout/i.test(err.message) ? 'TIMEOUT' : 'NETWORK', httpStatus: 0 }
  }
  // No raw remote body or transport error text escapes this API: they may contain account PII.
  if (Buffer.byteLength(response.text) > 64 * 1024) return { ok: false, code: 'INVALID_RESPONSE', httpStatus: response.status }
  let parsed: unknown
  try { parsed = JSON.parse(response.text) } catch { return { ok: false, code: 'INVALID_RESPONSE', httpStatus: response.status } }
  if (response.status < 200 || response.status >= 300) {
    const failure = z.object({ success: z.literal(false), protocol_version: z.literal(2), request_id: uuid.nullable(), error_code: z.string() }).strict().safeParse(parsed)
    if (failure.success && failure.data.request_id !== null && failure.data.request_id !== requestId) {
      return { ok: false, code: 'INVALID_RESPONSE', httpStatus: response.status }
    }
    return { ok: false, code: failure.success ? 'REMOTE_REJECTED' : 'HTTP', httpStatus: response.status,
      ...(failure.success && remoteCodes.has(failure.data.error_code) ? { remoteCode: failure.data.error_code } : {}) }
  }
  const result = schema.safeParse(parsed)
  if (!result.success || !matches(result.data)) return { ok: false, code: 'INVALID_RESPONSE', httpStatus: response.status }
  return { ok: true, body: result.data, httpStatus: response.status }
}

export function callFakaV2Capabilities(options: Options = {}, requestId: string = randomUUID()) {
  return callFakaV2('capabilities', {}, fakaV2CapabilitiesSchema, b => b.request_id === requestId, options, requestId)
}

export function callFakaV2ResolveAccount(externalOrderNo: string, options: Options = {}, requestId: string = randomUUID()): Promise<FakaV2Result<FakaV2ResolvedAccount>> {
  if (!orderNo.safeParse(externalOrderNo).success) return Promise.resolve({ ok: false, code: 'INVALID_REQUEST', httpStatus: 0 })
  return callFakaV2('user-resolve', { external_order_no: externalOrderNo }, resolveSchema,
    b => b.request_id === requestId && b.external_order_no === externalOrderNo, options, requestId)
}

export function callFakaV2Subscription(userId: string, options: Options = {}, requestId: string = randomUUID()): Promise<FakaV2Result<FakaV2Subscription>> {
  if (!id.safeParse(userId).success) return Promise.resolve({ ok: false, code: 'INVALID_REQUEST', httpStatus: 0 })
  return callFakaV2('user-subscription', { user_id: userId }, subscriptionSchema,
    b => b.request_id === requestId && b.account.user_id === userId, options, requestId)
}
