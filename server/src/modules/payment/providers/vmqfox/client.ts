import { logger } from '../../../../lib/logger.js'
import {
  isAllowedVmqfoxUrl,
  VMQFOX_MAX_RESPONSE_BYTES,
  type VmqfoxAdapterConfig,
} from './config.js'
import { createSignV2, queryByPayIdSignV2 } from './sign.js'

export type VmqfoxErrorKind =
  | 'monitor_offline'
  | 'configuration_error'
  | 'duplicate_order'
  | 'conflict'
  | 'overloaded'
  | 'rate_limited'
  | 'invalid_signature'
  | 'not_found'
  | 'invalid_argument'
  | 'malformed'
  | 'timeout'
  | 'server'

export class VmqfoxClientError extends Error {
  readonly kind: VmqfoxErrorKind
  constructor(kind: VmqfoxErrorKind, message: string) {
    super(message)
    this.name = 'VmqfoxClientError'
    this.kind = kind
  }
}

export type VmqfoxHttpRequest = {
  method: 'GET' | 'POST'
  url: string
  headers: Record<string, string>
  body?: string
  timeoutMs: number
}

export type VmqfoxHttpResponse = {
  status: number
  headers: Record<string, string>
  body: string
}

export type VmqfoxHttp = (req: VmqfoxHttpRequest) => Promise<VmqfoxHttpResponse>

export type VmqfoxEnvelope = {
  code: number
  msg: string
  data: Record<string, unknown> | null
}

export type VmqfoxCreateData = {
  payId: string
  orderId?: string
  publicToken: string
  payType: number
  price: string
  reallyPrice: string
  payUrl?: string
  isAuto?: number
  redirectUrl: string
}

export type VmqfoxQueryByPayIdData = {
  status: number
  publicToken: string
  type: number
  price: string
  reallyPrice: string
  createdAt?: number
  paidAt?: number
  closedAt?: number
}

export type VmqfoxGetData = {
  payId: string
  payType: number
  price: string
  reallyPrice: string
  state: number
  /** Historical redirect GET omits this; recovery QR asserts it separately. */
  payUrl?: string
  remainingSeconds?: number
}

export type VmqfoxCheckData = {
  state: number
  remainingSeconds?: number
}

const CREATE_PATH = '/api/order/create'
const GET_PATH = '/api/order/get'
const CHECK_PATH = '/api/order/check'
const QUERY_BY_PAY_ID_PATH = '/api/order/query-by-pay-id'

export function isRetryableUnknownKind(kind: VmqfoxErrorKind): boolean {
  return kind === 'timeout' || kind === 'server' || kind === 'malformed'
    || kind === 'rate_limited' || kind === 'overloaded'
    || kind === 'conflict' || kind === 'duplicate_order'
}

export function isDeterministicFailKind(kind: VmqfoxErrorKind): boolean {
  return kind === 'monitor_offline' || kind === 'configuration_error'
    || kind === 'invalid_argument' || kind === 'invalid_signature'
}

function encodeForm(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString()
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) {
    const text = await response.text()
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      throw new VmqfoxClientError('malformed', 'vmqfox response exceeded size limit')
    }
    return text
  }
  const chunks: Buffer[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined)
      throw new VmqfoxClientError('malformed', 'vmqfox response exceeded size limit')
    }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks).toString('utf8')
}

export async function defaultVmqfoxHttp(req: VmqfoxHttpRequest): Promise<VmqfoxHttpResponse> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), req.timeoutMs)
  try {
    const response = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.method === 'GET' ? undefined : req.body,
      redirect: 'manual',
      signal: controller.signal,
    })
    const headers: Record<string, string> = {}
    response.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value
    })
    if (response.status >= 300 && response.status < 400) {
      throw new VmqfoxClientError('malformed', 'vmqfox redirected')
    }
    const body = await readBoundedBody(response, VMQFOX_MAX_RESPONSE_BYTES)
    return { status: response.status, headers, body }
  } catch (err) {
    if (err instanceof VmqfoxClientError) throw err
    if (controller.signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
      throw new VmqfoxClientError('timeout', 'vmqfox request timed out')
    }
    throw new VmqfoxClientError('timeout', 'vmqfox network error')
  } finally {
    clearTimeout(timer)
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return null
}

export function pickString(value: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const entry = value[key]
    if (typeof entry === 'string') return entry
  }
  return undefined
}

export function pickInt(value: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const entry = value[key]
    if (typeof entry === 'number' && Number.isInteger(entry)) return entry
    if (typeof entry === 'string' && /^-?[0-9]+$/.test(entry)) return Number(entry)
  }
  return undefined
}

function classifyMessage(msg: string): VmqfoxErrorKind | null {
  if (msg.includes('监控端状态异常')) return 'monitor_offline'
  if (msg.includes('系统未配置密钥') || (msg.includes('notifyUrl') && msg.includes('无效'))) return 'configuration_error'
  if (msg.includes('订单超出负荷')) return 'overloaded'
  if (msg.includes('创建订单冲突') || msg.includes('订单状态已变化')) return 'conflict'
  if (msg.includes('签名错误') || msg.includes('已废弃的 v1 签名')) return 'invalid_signature'
  if (msg.includes('订单不存在')) return 'not_found'
  if (msg.includes('参数不完整') || msg.includes('支付类型错误') || msg.includes('价格错误')) return 'invalid_argument'
  if (msg.includes('重复')) return 'duplicate_order'
  if (msg.includes('请求过于频繁')) return 'rate_limited'
  return null
}

function parseEnvelope(status: number, body: string): VmqfoxEnvelope {
  if (status === 429) {
    throw new VmqfoxClientError('rate_limited', 'vmqfox rate limited')
  }
  if (status >= 500) {
    throw new VmqfoxClientError('server', 'vmqfox server error')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(body) as unknown
  } catch {
    throw new VmqfoxClientError('malformed', 'vmqfox response was not JSON')
  }
  const record = asRecord(parsed)
  if (!record || typeof record.code !== 'number' || typeof record.msg !== 'string') {
    throw new VmqfoxClientError('malformed', 'vmqfox envelope is invalid')
  }
  const data = record.data == null ? null : asRecord(record.data)
  if (record.data != null && !data) {
    throw new VmqfoxClientError('malformed', 'vmqfox data is invalid')
  }
  return { code: record.code, msg: record.msg, data }
}

function throwEnvelopeError(envelope: VmqfoxEnvelope, status: number): never {
  const fromMsg = classifyMessage(envelope.msg)
  if (fromMsg) throw new VmqfoxClientError(fromMsg, envelope.msg)
  if (status === 429 || envelope.code === 429) throw new VmqfoxClientError('rate_limited', envelope.msg)
  if (envelope.code === 409) throw new VmqfoxClientError('conflict', envelope.msg)
  if (envelope.code >= 500) throw new VmqfoxClientError('server', envelope.msg)
  throw new VmqfoxClientError('invalid_argument', envelope.msg || 'vmqfox request failed')
}

function requireAllowlistedUrl(config: VmqfoxAdapterConfig, url: string): void {
  if (!isAllowedVmqfoxUrl(url, config.allowedOrigins)) {
    throw new VmqfoxClientError('configuration_error', 'vmqfox request URL is not allowlisted')
  }
}

async function send(
  config: VmqfoxAdapterConfig,
  http: VmqfoxHttp,
  req: Omit<VmqfoxHttpRequest, 'timeoutMs'> & { timeoutMs?: number },
): Promise<VmqfoxEnvelope> {
  requireAllowlistedUrl(config, req.url)
  logger.info({
    event: 'payment.vmqfox_request',
    provider: 'vmqfox',
    method: req.method,
    path: new URL(req.url).pathname.replace(/\/[0-9a-f]{64}$/i, '/:token'),
  }, 'vmqfox request')
  let response: VmqfoxHttpResponse
  try {
    response = await http({
      ...req,
      timeoutMs: req.timeoutMs ?? config.requestTimeoutMs,
    })
  } catch (err) {
    if (err instanceof VmqfoxClientError) throw err
    throw new VmqfoxClientError('timeout', 'vmqfox network error')
  }
  const envelope = parseEnvelope(response.status, response.body)
  if (envelope.code !== 200 || envelope.data == null) {
    throwEnvelopeError(envelope, response.status)
  }
  return envelope
}

function pickCreateData(data: Record<string, unknown>): VmqfoxCreateData {
  const payId = pickString(data, 'payId')
  const publicToken = pickString(data, 'publicToken')
  const redirectUrl = pickString(data, 'redirectUrl')
  const price = pickString(data, 'price')
  const reallyPrice = pickString(data, 'reallyPrice')
  const payType = pickInt(data, 'payType')
  if (!payId || !publicToken || !redirectUrl || !price || !reallyPrice || payType == null) {
    throw new VmqfoxClientError('malformed', 'vmqfox create payload missing allowlisted fields')
  }
  return {
    payId,
    orderId: pickString(data, 'orderId'),
    publicToken,
    payType,
    price,
    reallyPrice,
    payUrl: pickString(data, 'payUrl'),
    isAuto: pickInt(data, 'isAuto'),
    redirectUrl,
  }
}

function pickQueryByPayIdData(data: Record<string, unknown>): VmqfoxQueryByPayIdData {
  const status = pickInt(data, 'status', 'state')
  const publicToken = pickString(data, 'publicToken')
  const type = pickInt(data, 'type', 'payType')
  const price = pickString(data, 'price')
  const reallyPrice = pickString(data, 'reallyPrice')
  if (status == null || !publicToken || type == null || !price || !reallyPrice) {
    throw new VmqfoxClientError('malformed', 'vmqfox query payload missing allowlisted fields')
  }
  return {
    status,
    publicToken,
    type,
    price,
    reallyPrice,
    createdAt: pickInt(data, 'createdAt'),
    paidAt: pickInt(data, 'paidAt'),
    closedAt: pickInt(data, 'closedAt'),
  }
}

function pickGetData(data: Record<string, unknown>): VmqfoxGetData {
  const payId = pickString(data, 'payId')
  const payType = pickInt(data, 'payType', 'type')
  const price = pickString(data, 'price')
  const reallyPrice = pickString(data, 'reallyPrice')
  const state = pickInt(data, 'state', 'status')
  if (!payId || payType == null || !price || !reallyPrice || state == null) {
    throw new VmqfoxClientError('malformed', 'vmqfox get payload missing allowlisted fields')
  }
  return {
    payId,
    payType,
    price,
    reallyPrice,
    state,
    payUrl: pickString(data, 'payUrl'),
    remainingSeconds: pickInt(data, 'remainingSeconds'),
  }
}

function pickCheckData(data: Record<string, unknown>): VmqfoxCheckData {
  const state = pickInt(data, 'state', 'status')
  if (state == null) {
    throw new VmqfoxClientError('malformed', 'vmqfox check payload missing state')
  }
  return { state, remainingSeconds: pickInt(data, 'remainingSeconds') }
}

export type VmqfoxApi = {
  create(input: {
    payId: string
    param: string
    type: string
    price: string
    notifyUrl: string
    returnUrl: string
  }): Promise<VmqfoxCreateData>
  queryByPayId(payId: string, now?: Date): Promise<VmqfoxQueryByPayIdData>
  get(publicToken: string): Promise<VmqfoxGetData>
  check(publicToken: string): Promise<VmqfoxCheckData>
}

export function createVmqfoxApi(config: VmqfoxAdapterConfig, http: VmqfoxHttp = defaultVmqfoxHttp): VmqfoxApi {
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/x-www-form-urlencoded',
    'User-Agent': 'monexus-vmqfox-adapter',
  }

  return {
    async create(input) {
      const sign = createSignV2(input, config.merchantKey)
      const body = encodeForm({ ...input, sign })
      const envelope = await send(config, http, {
        method: 'POST',
        url: `${config.baseUrl}${CREATE_PATH}`,
        headers,
        body,
      })
      return pickCreateData(envelope.data!)
    },

    async queryByPayId(payId, now = new Date()) {
      const timestamp = now.getTime().toString(10)
      const sign = queryByPayIdSignV2({ payId, timestamp }, config.merchantKey)
      const body = encodeForm({ payId, t: timestamp, sign })
      const envelope = await send(config, http, {
        method: 'POST',
        url: `${config.baseUrl}${QUERY_BY_PAY_ID_PATH}`,
        headers,
        body,
      })
      return pickQueryByPayIdData(envelope.data!)
    },

    async get(publicToken) {
      const envelope = await send(config, http, {
        method: 'GET',
        url: `${config.baseUrl}${GET_PATH}/${publicToken}`,
        headers,
      })
      return pickGetData(envelope.data!)
    },

    async check(publicToken) {
      const envelope = await send(config, http, {
        method: 'GET',
        url: `${config.baseUrl}${CHECK_PATH}/${publicToken}`,
        headers,
      })
      return pickCheckData(envelope.data!)
    },
  }
}
