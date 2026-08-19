export class PaypalTimeoutError extends Error {
  constructor(message = 'paypal api timeout') {
    super(message)
    this.name = 'PaypalTimeoutError'
  }
}

export class PaypalHttpError extends Error {
  constructor(
    readonly stableCode: string,
    readonly httpStatus: number,
    readonly issue?: string,
  ) {
    super(stableCode)
    this.name = 'PaypalHttpError'
  }
}

export type PaypalTransportRequest = {
  method: 'GET' | 'POST'
  url: string
  headers: Record<string, string>
  body?: string
  timeoutMs: number
}

export type PaypalTransportResponse = {
  status: number
  headers: Record<string, string>
  bodyText: string
}

export type PaypalTransport = (req: PaypalTransportRequest) => Promise<PaypalTransportResponse>

export type PaypalApiRequest = {
  method: 'GET' | 'POST'
  path: string
  headers?: Record<string, string>
  json?: unknown
  form?: Record<string, string>
  timeoutMs?: number
  /** OAuth token request must not send Bearer. */
  anonymous?: boolean
}

export type PaypalApiClient = {
  request(req: PaypalApiRequest): Promise<PaypalTransportResponse>
}

const DEFAULT_TIMEOUT_MS = 15_000

type TokenCacheEntry = {
  accessToken: string
  expiresAtMs: number
}

export function createPaypalFetchTransport(): PaypalTransport {
  return async req => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), req.timeoutMs)
    try {
      const response = await fetch(req.url, {
        method: req.method,
        headers: req.headers,
        body: req.body,
        signal: controller.signal,
      })
      const bodyText = await response.text()
      const headers: Record<string, string> = {}
      response.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value
      })
      return { status: response.status, headers, bodyText }
    } catch (err) {
      if (controller.signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
        throw new PaypalTimeoutError()
      }
      throw new PaypalTimeoutError('paypal api unknown')
    } finally {
      clearTimeout(timer)
    }
  }
}

export function readPaypalIssue(bodyText: string): string | undefined {
  try {
    const parsed = JSON.parse(bodyText) as {
      name?: unknown
      details?: Array<{ issue?: unknown }>
    }
    const issue = parsed.details?.[0]?.issue
    if (typeof issue === 'string' && issue.length > 0) return issue
    if (typeof parsed.name === 'string' && parsed.name.length > 0) return parsed.name
  } catch {
    return undefined
  }
  return undefined
}

export function isPaypalAlreadyCaptured(err: unknown): boolean {
  return err instanceof PaypalHttpError && (
    err.issue === 'ORDER_ALREADY_CAPTURED'
    || err.stableCode === 'ORDER_ALREADY_CAPTURED'
  )
}

export function isPaypalNotApproved(err: unknown): boolean {
  return err instanceof PaypalHttpError && (
    err.issue === 'ORDER_NOT_APPROVED'
    || err.stableCode === 'ORDER_NOT_APPROVED'
  )
}

export function isPaypalUnprocessable(err: unknown): boolean {
  return err instanceof PaypalHttpError && (err.httpStatus === 422 || err.httpStatus === 409)
}

export function isPaypalTimeoutOrUnknown(err: unknown): boolean {
  return err instanceof PaypalTimeoutError
}

function encodeBasicAuth(clientId: string, clientSecret: string): string {
  return Buffer.from(`${clientId}:${clientSecret}`, 'utf8').toString('base64')
}

export function createPaypalApiClient(input: {
  apiBaseUrl: string
  clientId: string
  clientSecret: string
  transport: PaypalTransport
  timeoutMs?: number
  now?: () => number
}): PaypalApiClient {
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const now = input.now ?? Date.now
  const cache = new Map<string, TokenCacheEntry>()
  const cacheKey = `${input.apiBaseUrl}|${input.clientId}`

  async function raw(req: PaypalApiRequest, bearer?: string): Promise<PaypalTransportResponse> {
    const headers: Record<string, string> = { ...(req.headers ?? {}) }
    if (bearer) headers.Authorization = `Bearer ${bearer}`
    let body: string | undefined
    if (req.form) {
      headers['Content-Type'] = headers['Content-Type'] ?? 'application/x-www-form-urlencoded'
      body = new URLSearchParams(req.form).toString()
    } else if (req.json !== undefined) {
      headers['Content-Type'] = headers['Content-Type'] ?? 'application/json'
      body = typeof req.json === 'string' ? req.json : JSON.stringify(req.json)
    }
    const url = `${input.apiBaseUrl.replace(/\/$/, '')}${req.path}`
    return input.transport({
      method: req.method,
      url,
      headers,
      body,
      timeoutMs: req.timeoutMs ?? timeoutMs,
    })
  }

  async function token(): Promise<string> {
    const cached = cache.get(cacheKey)
    if (cached && cached.expiresAtMs > now() + 5_000) return cached.accessToken
    const response = await raw({
      method: 'POST',
      path: '/v1/oauth2/token',
      anonymous: true,
      headers: {
        Authorization: `Basic ${encodeBasicAuth(input.clientId, input.clientSecret)}`,
        Accept: 'application/json',
      },
      form: { grant_type: 'client_credentials' },
    })
    if (response.status >= 400) {
      throw new PaypalHttpError('PAYPAL_AUTH_FAILED', response.status, readPaypalIssue(response.bodyText))
    }
    let parsed: { access_token?: unknown; expires_in?: unknown }
    try {
      parsed = JSON.parse(response.bodyText) as { access_token?: unknown; expires_in?: unknown }
    } catch {
      throw new PaypalHttpError('PAYPAL_AUTH_FAILED', response.status)
    }
    if (typeof parsed.access_token !== 'string' || parsed.access_token.length === 0) {
      throw new PaypalHttpError('PAYPAL_AUTH_FAILED', response.status)
    }
    const expiresInSec = typeof parsed.expires_in === 'number' && Number.isFinite(parsed.expires_in)
      ? parsed.expires_in
      : 300
    cache.set(cacheKey, {
      accessToken: parsed.access_token,
      expiresAtMs: now() + Math.max(30, expiresInSec) * 1000,
    })
    return parsed.access_token
  }

  return {
    async request(req: PaypalApiRequest): Promise<PaypalTransportResponse> {
      const bearer = req.anonymous ? undefined : await token()
      const response = await raw(req, bearer)
      if (!req.anonymous && response.status === 401) {
        cache.delete(cacheKey)
        const retried = await raw(req, await token())
        return retried
      }
      return response
    },
  }
}

export function parsePaypalJson(bodyText: string): unknown {
  try {
    return JSON.parse(bodyText) as unknown
  } catch {
    throw new PaypalHttpError('PAYPAL_RESPONSE_INVALID', 0)
  }
}

export function throwIfPaypalFailed(response: PaypalTransportResponse): void {
  if (response.status >= 400) {
    const issue = readPaypalIssue(response.bodyText)
    throw new PaypalHttpError(issue ?? 'PAYPAL_REQUEST_FAILED', response.status, issue)
  }
}

export function headerValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const wanted = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted) continue
    if (Array.isArray(value)) return value[0]
    return value
  }
  return undefined
}
