import { paymentProviderUnavailable, paymentStateUnknown } from '../../../../lib/httpError.js'
import {
  buildAuthorizationHeader,
  buildResponseSignMessage,
  headerValue,
  randomNonce,
  rsaSha256Verify,
  unixTimestampSeconds,
} from './crypto.js'
import type { WechatPayCredentials } from './credentials.js'

export type WechatPayHttpResponse = {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: string
}

export type WechatPayHttpRequest = {
  method: string
  url: string
  pathAndQuery: string
  body: string
  headers: Record<string, string>
}

export type WechatPayHttp = (input: WechatPayHttpRequest) => Promise<WechatPayHttpResponse>

export class WechatPayUnknownResultError extends Error {
  readonly code = 'PAYMENT_STATE_UNKNOWN'
  constructor(message = 'WeChat Pay result is unknown') {
    super(message)
    this.name = 'WechatPayUnknownResultError'
  }
}

const REQUEST_TIMEOUT_MS = 10_000

export function defaultWechatPayHttp(input: WechatPayHttpRequest): Promise<WechatPayHttpResponse> {
  return fetch(input.url, {
    method: input.method,
    headers: input.headers,
    body: input.method === 'GET' ? undefined : input.body,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }).then(async response => {
    const headers: Record<string, string> = {}
    response.headers.forEach((value, key) => {
      headers[key] = value
    })
    return { status: response.status, headers, body: await response.text() }
  }).catch(err => {
    throw new WechatPayUnknownResultError(err instanceof Error ? err.name : 'network')
  })
}

export type WechatPayRequestOptions = {
  credentials: WechatPayCredentials
  http: WechatPayHttp
  now: () => Date
  method: 'GET' | 'POST'
  pathAndQuery: string
  body?: string
  requireSignature?: boolean
}

export type WechatPayApiResult = {
  status: number
  body: string
  json: unknown
}

function pathOf(apiBaseUrl: string, pathAndQuery: string): string {
  return `${apiBaseUrl.replace(/\/$/, '')}${pathAndQuery}`
}

export async function wechatPayRequest(options: WechatPayRequestOptions): Promise<WechatPayApiResult> {
  const body = options.body ?? ''
  const timestamp = unixTimestampSeconds(options.now())
  const nonce = randomNonce()
  const authorization = buildAuthorizationHeader({
    mchid: options.credentials.mchid,
    serialNo: options.credentials.merchantSerialNo,
    privateKeyPem: options.credentials.merchantPrivateKeyPem,
    method: options.method,
    urlPathAndQuery: options.pathAndQuery,
    body,
    timestamp,
    nonce,
  })
  const headers: Record<string, string> = {
    Authorization: authorization,
    Accept: 'application/json',
    'User-Agent': 'monexus-wechat-pay-adapter',
    'Wechatpay-Serial': options.credentials.platformSerialNo,
  }
  if (options.method !== 'GET') {
    headers['Content-Type'] = 'application/json'
  }

  let response: WechatPayHttpResponse
  try {
    response = await options.http({
      method: options.method,
      url: pathOf(options.credentials.apiBaseUrl, options.pathAndQuery),
      pathAndQuery: options.pathAndQuery,
      body,
      headers,
    })
  } catch (err) {
    if (err instanceof WechatPayUnknownResultError) throw err
    throw new WechatPayUnknownResultError()
  }

  const shouldVerify = options.requireSignature !== false && response.status >= 200 && response.status < 300
  if (shouldVerify) {
    const serial = headerValue(response.headers, 'Wechatpay-Serial')
    const signature = headerValue(response.headers, 'Wechatpay-Signature')
    const ts = headerValue(response.headers, 'Wechatpay-Timestamp')
    const respNonce = headerValue(response.headers, 'Wechatpay-Nonce')
    if (response.status !== 204) {
      if (!signature || !ts || !respNonce) throw paymentProviderUnavailable()
      if (serial && serial !== options.credentials.platformSerialNo) throw paymentProviderUnavailable()
      const message = buildResponseSignMessage(ts, respNonce, response.body)
      if (!rsaSha256Verify(options.credentials.platformPublicKeyPem, message, signature)) {
        throw paymentProviderUnavailable()
      }
    }
  }

  let json: unknown = null
  if (response.body.length > 0) {
    try {
      json = JSON.parse(response.body) as unknown
    } catch {
      if (response.status >= 200 && response.status < 300) throw paymentStateUnknown()
      json = null
    }
  }
  return { status: response.status, body: response.body, json }
}

export function wechatErrorCode(json: unknown): string | undefined {
  if (!json || typeof json !== 'object') return undefined
  const code = (json as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}
