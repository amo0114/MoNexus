import { request as httpsRequest } from 'node:https'
import { request as httpRequest } from 'node:http'
import type { IncomingMessage, ClientRequest } from 'node:http'
import type { Socket } from 'node:net'
import { URL } from 'node:url'
import { config } from '../../config/index.js'
import { withFakaSignature } from './sign.js'
import { classifyFakaHttpFailure, FAKA_ERROR, type FakaErrorCode } from './errors.js'
import type {
  FakaHttpResult,
  FakaOrderPaidRequest,
  FakaOrderPaidResponse,
  FakaOrderRevokeResponse,
  FakaOrderStatusResponse,
  FakaPlanCapacityResponse,
  FakaPlanCatalogResponse,
  FakaTransport,
} from './types.js'

const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024

export interface FakaBridgeClientOptions {
  url?: string
  statusUrl?: string
  revokeUrl?: string
  capacityUrl?: string
  catalogUrl?: string
  secret?: string
  timeoutMs?: number
  allowInsecureTargets?: boolean
  transport?: FakaTransport
  maxResponseBytes?: number
}

function resolveConfig(overrides: FakaBridgeClientOptions = {}) {
  const cfg = config.fakaBridge
  const url = overrides.url ?? cfg.url
  const secret = overrides.secret ?? cfg.secret
  const timeoutMs = overrides.timeoutMs ?? cfg.timeoutMs
  const allowInsecure =
    overrides.allowInsecureTargets ?? cfg.allowInsecureTargets ?? false
  const statusUrl =
    overrides.statusUrl ??
    cfg.statusUrl ??
    (url ? url.replace(/\/order-paid\/?$/, '/order-status') : undefined)
  const revokeUrl =
    overrides.revokeUrl ??
    cfg.revokeUrl ??
    (url ? url.replace(/\/order-paid\/?$/, '/order-revoke') : undefined)
  const capacityUrl =
    overrides.capacityUrl ??
    (url ? url.replace(/\/order-paid\/?$/, '/plan-capacity') : undefined)
  const catalogUrl =
    overrides.catalogUrl ??
    (url ? url.replace(/\/order-paid\/?$/, '/plan-catalog') : undefined)

  return { url, secret, timeoutMs, allowInsecure, statusUrl, revokeUrl, capacityUrl, catalogUrl }
}

export function isFakaBridgeConfigured(overrides: FakaBridgeClientOptions = {}): boolean {
  const { url, secret } = resolveConfig(overrides)
  return Boolean(url && secret)
}

/** Read HTTPS_PROXY/HTTP_PROXY (curl-compatible). Empty → direct. */
export function resolveHttpProxyFromEnv(): URL | null {
  const raw =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    ''
  if (!raw.trim()) return null
  try {
    return new URL(raw)
  } catch {
    return null
  }
}

function hostMatchesNoProxy(hostname: string, noProxy: string): boolean {
  if (!noProxy.trim()) return false
  const host = hostname.toLowerCase()
  for (const raw of noProxy.split(',')) {
    const entry = raw.trim().toLowerCase()
    if (!entry) continue
    if (entry === '*') return true
    if (entry === host) return true
    if (entry.startsWith('.') && (host.endsWith(entry) || host === entry.slice(1))) return true
    if (host.endsWith(`.${entry}`)) return true
  }
  return false
}

function shouldUseProxy(target: URL, proxy: URL | null): proxy is URL {
  if (!proxy) return false
  if (proxy.protocol !== 'http:' && proxy.protocol !== 'https:') return false
  const noProxy = process.env.NO_PROXY || process.env.no_proxy || ''
  if (hostMatchesNoProxy(target.hostname, noProxy)) return false
  return true
}

function collectResponse(
  res: IncomingMessage,
  resolve: (v: { status: number; text: string }) => void,
  reject: (err: Error) => void
) {
  const chunks: Buffer[] = []
  let total = 0
  res.on('data', (chunk: Buffer) => {
    total += chunk.length
    if (total > DEFAULT_MAX_RESPONSE_BYTES) {
      res.destroy(new Error('FakaBridge response too large'))
      return
    }
    chunks.push(chunk)
  })
  res.on('end', () => {
    resolve({
      status: res.statusCode ?? 0,
      text: Buffer.concat(chunks).toString('utf8'),
    })
  })
  res.on('error', reject)
}

function attachTimeout(req: ClientRequest, timeoutMs: number, reject: (err: Error) => void) {
  req.setTimeout(timeoutMs, () => {
    req.destroy(new Error('FakaBridge request timeout'))
  })
  req.on('timeout', () => {
    req.destroy(new Error('FakaBridge request timeout'))
  })
  req.on('error', reject)
}

/**
 * HTTPS via HTTP CONNECT proxy (needed when direct egress is blocked, e.g. WSL + system proxy).
 * Node's https.request does not honor HTTPS_PROXY by default.
 */
function requestViaHttpProxy(
  target: URL,
  proxy: URL,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
  timeoutMs: number
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const targetPort = Number(target.port || (target.protocol === 'https:' ? 443 : 80))
    const connectPath = `${target.hostname}:${targetPort}`
    const proxyAuth =
      proxy.username || proxy.password
        ? Buffer.from(
            `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`
          ).toString('base64')
        : null

    const connectHeaders: Record<string, string> = {
      Host: connectPath,
    }
    if (proxyAuth) connectHeaders['Proxy-Authorization'] = `Basic ${proxyAuth}`

    const connectReq = httpRequest({
      protocol: proxy.protocol,
      hostname: proxy.hostname,
      port: proxy.port || (proxy.protocol === 'https:' ? 443 : 80),
      method: 'CONNECT',
      path: connectPath,
      headers: connectHeaders,
      timeout: timeoutMs,
      family: 4,
    })

    const onFail = (err: Error) => {
      connectReq.destroy()
      reject(err)
    }

    connectReq.setTimeout(timeoutMs, () => onFail(new Error('FakaBridge request timeout')))
    connectReq.on('timeout', () => onFail(new Error('FakaBridge request timeout')))
    connectReq.on('error', onFail)

    connectReq.on('connect', (res, socket: Socket) => {
      if (res.statusCode !== 200) {
        socket.destroy()
        reject(new Error(`FakaBridge proxy CONNECT failed: HTTP ${res.statusCode ?? 0}`))
        return
      }

      // After CONNECT, hand the duplex socket to http(s).request.
      // For HTTPS, Node performs TLS on this socket (SNI = public hostname).
      const lib = target.protocol === 'https:' ? httpsRequest : httpRequest
      const req = lib(
        {
          servername: target.hostname,
          host: target.hostname,
          port: String(targetPort),
          path: `${target.pathname}${target.search}`,
          method,
          headers,
          timeout: timeoutMs,
          // Reuse the already-open CONNECT tunnel (Node RequestOptions typing
          // omits this socket reuse path; createConnection is the public hook).
          createConnection: () => socket,
        },
        r => collectResponse(r, resolve, reject)
      )
      attachTimeout(req, timeoutMs, reject)
      if (body) req.write(body)
      req.end()
    })

    connectReq.end()
  })
}

/**
 * Minimal HTTP transport (no redirect follow). Prefer https in production;
 * http only when allowInsecureTargets is true (local mock).
 * Honors HTTPS_PROXY/HTTP_PROXY + NO_PROXY when set (curl-compatible).
 */
export function defaultFakaTransport(allowInsecure: boolean): FakaTransport {
  return ({ method, url, headers, body, timeoutMs }) =>
    new Promise((resolve, reject) => {
      let parsed: URL
      try {
        parsed = new URL(url)
      } catch (err) {
        reject(err)
        return
      }

      if (parsed.protocol === 'http:' && !allowInsecure) {
        reject(new Error('FakaBridge refuses http targets unless allowInsecureTargets is true'))
        return
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        reject(new Error(`Unsupported protocol: ${parsed.protocol}`))
        return
      }

      const proxy = resolveHttpProxyFromEnv()
      if (shouldUseProxy(parsed, proxy)) {
        requestViaHttpProxy(parsed, proxy, method, headers, body, timeoutMs).then(resolve, reject)
        return
      }

      const lib = parsed.protocol === 'https:' ? httpsRequest : httpRequest
      const req = lib(
        {
          protocol: parsed.protocol,
          hostname: parsed.hostname,
          port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
          path: `${parsed.pathname}${parsed.search}`,
          method,
          headers,
          timeout: timeoutMs,
          // Prefer IPv4: some WSL/cloud dual-stack paths hang on AAAA then timeout.
          family: 4,
        },
        res => collectResponse(res, resolve, reject)
      )

      attachTimeout(req, timeoutMs, reject)
      if (body) req.write(body)
      req.end()
    })
}

function parseJsonSafe(text: string): unknown | null {
  if (!text) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

function wrapResult<T>(
  httpStatus: number,
  text: string,
  body: T | null,
  code: FakaErrorCode,
  ok: boolean
): FakaHttpResult<T> {
  return { ok, httpStatus, code, body, rawText: text.slice(0, 500) }
}

/** Empty-body failure helper so callers get a typed FakaHttpResult without inferring T=null. */
function wrapFail<T>(
  httpStatus: number,
  text: string,
  code: FakaErrorCode
): FakaHttpResult<T> {
  return wrapResult<T>(httpStatus, text, null, code, false)
}

/**
 * POST order-paid to Xboard FakaBridge.
 * Always signs the body. Does not throw on 4xx/5xx — returns structured result.
 */
export async function callFakaOrderPaid(
  input: Omit<FakaOrderPaidRequest, 'sign'>,
  overrides: FakaBridgeClientOptions = {}
): Promise<FakaHttpResult<FakaOrderPaidResponse>> {
  const { url, secret, timeoutMs, allowInsecure } = resolveConfig(overrides)
  if (!url || !secret) {
    return wrapFail(0, '', FAKA_ERROR.NOT_CONFIGURED)
  }

  if (!input.order_no || !input.email || !input.sku || !input.paid_at) {
    return wrapFail(0, '', FAKA_ERROR.INVALID_REQUEST)
  }

  const payload = withFakaSignature(
    {
      order_no: input.order_no,
      email: input.email.toLowerCase().trim(),
      sku: input.sku,
      period: input.period ?? 'monthly',
      paid_at: input.paid_at,
    },
    secret
  )

  const body = JSON.stringify(payload)
  const transport = overrides.transport ?? defaultFakaTransport(allowInsecure)

  try {
    const res = await transport({
      method: 'POST',
      url,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'Content-Length': String(Buffer.byteLength(body)),
      },
      body,
      timeoutMs,
    })

    const parsed = parseJsonSafe(res.text) as FakaOrderPaidResponse | null
    if (res.status >= 200 && res.status < 300 && parsed && parsed.success === true) {
      return wrapResult(res.status, res.text, parsed, FAKA_ERROR.UNKNOWN, true)
    }

    const errMsg =
      parsed && typeof parsed === 'object' && 'error' in parsed
        ? String((parsed as FakaOrderPaidResponse & { error?: string }).error ?? '')
        : ''
    const code =
      res.status >= 200 && res.status < 300 && parsed && parsed.success === false
        ? FAKA_ERROR.BUSINESS
        : classifyFakaHttpFailure(res.status, errMsg)

    return wrapResult(res.status, res.text, parsed, code, false)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const code = /timeout/i.test(msg) ? FAKA_ERROR.TIMEOUT : FAKA_ERROR.NETWORK
    return wrapFail(0, msg, code)
  }
}

/**
 * GET order-status (signed query string).
 */
export async function callFakaOrderStatus(
  orderNo: string,
  overrides: FakaBridgeClientOptions = {}
): Promise<FakaHttpResult<FakaOrderStatusResponse>> {
  const { statusUrl, secret, timeoutMs, allowInsecure } = resolveConfig(overrides)
  if (!statusUrl || !secret) {
    return wrapFail(0, '', FAKA_ERROR.NOT_CONFIGURED)
  }
  if (!orderNo) {
    return wrapFail(0, '', FAKA_ERROR.INVALID_REQUEST)
  }

  const signed = withFakaSignature({ order_no: orderNo }, secret)
  const qs = new URLSearchParams({
    order_no: signed.order_no,
    sign: signed.sign,
  }).toString()
  const url = `${statusUrl}${statusUrl.includes('?') ? '&' : '?'}${qs}`

  const transport = overrides.transport ?? defaultFakaTransport(allowInsecure)

  try {
    const res = await transport({
      method: 'GET',
      url,
      headers: { Accept: 'application/json' },
      timeoutMs,
    })

    const parsed = parseJsonSafe(res.text) as FakaOrderStatusResponse | null
    if (res.status >= 200 && res.status < 300 && parsed && parsed.success === true) {
      return wrapResult(res.status, res.text, parsed, FAKA_ERROR.UNKNOWN, true)
    }

    const errMsg =
      parsed && typeof parsed === 'object' && 'error' in parsed
        ? String((parsed as { error?: string }).error ?? '')
        : ''
    const code = classifyFakaHttpFailure(res.status, errMsg)
    return wrapResult(res.status, res.text, parsed, code, false)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const code = /timeout/i.test(msg) ? FAKA_ERROR.TIMEOUT : FAKA_ERROR.NETWORK
    return wrapFail(0, msg, code)
  }
}

/**
 * POST order-revoke — expire Xboard subscription after MoNexus refund.
 */
export async function callFakaOrderRevoke(
  orderNo: string,
  reason?: string,
  overrides: FakaBridgeClientOptions = {}
): Promise<FakaHttpResult<FakaOrderRevokeResponse>> {
  const { revokeUrl, secret, timeoutMs, allowInsecure } = resolveConfig(overrides)
  if (!revokeUrl || !secret) {
    return wrapFail(0, '', FAKA_ERROR.NOT_CONFIGURED)
  }
  if (!orderNo) {
    return wrapFail(0, '', FAKA_ERROR.INVALID_REQUEST)
  }

  const paidAt = Math.floor(Date.now() / 1000)
  const payloadBase: Record<string, string | number> = {
    order_no: orderNo,
    paid_at: paidAt,
  }
  if (reason && reason.trim()) {
    payloadBase.reason = reason.trim().slice(0, 200)
  }
  const payload = withFakaSignature(payloadBase, secret)
  const body = JSON.stringify(payload)
  const transport = overrides.transport ?? defaultFakaTransport(allowInsecure)

  try {
    const res = await transport({
      method: 'POST',
      url: revokeUrl,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'Content-Length': String(Buffer.byteLength(body)),
      },
      body,
      timeoutMs,
    })

    const parsed = parseJsonSafe(res.text) as FakaOrderRevokeResponse | null
    if (res.status >= 200 && res.status < 300 && parsed && parsed.success === true) {
      return wrapResult(res.status, res.text, parsed, FAKA_ERROR.UNKNOWN, true)
    }

    const errMsg =
      parsed && typeof parsed === 'object' && 'error' in parsed
        ? String((parsed as { error?: string }).error ?? '')
        : ''
    const code = classifyFakaHttpFailure(res.status, errMsg)
    return wrapResult(res.status, res.text, parsed, code, false)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const code = /timeout/i.test(msg) ? FAKA_ERROR.TIMEOUT : FAKA_ERROR.NETWORK
    return wrapFail(0, msg, code)
  }
}

/**
 * GET plan-capacity (signed query). Used for MoNexus checkout precheck of
 * Xboard capacity_limit (订阅人数限制) — not local MoNexus stock.
 */
export async function callFakaPlanCapacity(
  sku: string,
  overrides: FakaBridgeClientOptions = {}
): Promise<FakaHttpResult<FakaPlanCapacityResponse>> {
  const { capacityUrl, secret, timeoutMs, allowInsecure } = resolveConfig(overrides)
  if (!capacityUrl || !secret) {
    return wrapFail(0, '', FAKA_ERROR.NOT_CONFIGURED)
  }
  const skuNorm = sku.trim().toLowerCase()
  if (!skuNorm) {
    return wrapFail(0, '', FAKA_ERROR.INVALID_REQUEST)
  }

  const paidAt = Math.floor(Date.now() / 1000)
  const signed = withFakaSignature({ sku: skuNorm, paid_at: paidAt }, secret)
  const qs = new URLSearchParams({
    sku: signed.sku,
    paid_at: String(signed.paid_at),
    sign: signed.sign,
  }).toString()
  const url = `${capacityUrl}${capacityUrl.includes('?') ? '&' : '?'}${qs}`

  const transport = overrides.transport ?? defaultFakaTransport(allowInsecure)

  try {
    const res = await transport({
      method: 'GET',
      url,
      headers: { Accept: 'application/json' },
      timeoutMs,
    })

    const parsed = parseJsonSafe(res.text) as FakaPlanCapacityResponse | null
    if (res.status >= 200 && res.status < 300 && parsed && parsed.success === true) {
      return wrapResult(res.status, res.text, parsed, FAKA_ERROR.UNKNOWN, true)
    }

    const errMsg =
      parsed && typeof parsed === 'object' && 'error' in parsed
        ? String((parsed as { error?: string }).error ?? '')
        : ''
    const code = classifyFakaHttpFailure(res.status, errMsg)
    return wrapResult(res.status, res.text, parsed, code, false)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const code = /timeout/i.test(msg) ? FAKA_ERROR.TIMEOUT : FAKA_ERROR.NETWORK
    return wrapFail(0, msg, code)
  }
}

/**
 * POST plan-capacity — set Xboard capacity_limit (null = unlimited).
 * Platform HMAC only; never exposed to buyers/merchants.
 */
export async function callFakaSetPlanCapacity(
  sku: string,
  capacityLimit: number | null,
  overrides: FakaBridgeClientOptions = {}
): Promise<FakaHttpResult<FakaPlanCapacityResponse>> {
  const { capacityUrl, secret, timeoutMs, allowInsecure } = resolveConfig(overrides)
  if (!capacityUrl || !secret) {
    return wrapFail(0, '', FAKA_ERROR.NOT_CONFIGURED)
  }
  const skuNorm = sku.trim().toLowerCase()
  if (!skuNorm) {
    return wrapFail(0, '', FAKA_ERROR.INVALID_REQUEST)
  }

  const paidAt = Math.floor(Date.now() / 1000)
  const payload: Record<string, string | number> = {
    sku: skuNorm,
    paid_at: paidAt,
  }
  // Include capacity_limit only when finite — null means unlimited; send empty string
  // is ambiguous for PHP. Plugin treats missing/null/'' as unlimited.
  if (capacityLimit != null) {
    payload.capacity_limit = capacityLimit
  }

  const signed = withFakaSignature(payload, secret)
  const body = JSON.stringify(signed)
  const transport = overrides.transport ?? defaultFakaTransport(allowInsecure)

  try {
    const res = await transport({
      method: 'POST',
      url: capacityUrl,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'Content-Length': String(Buffer.byteLength(body)),
      },
      body,
      timeoutMs,
    })

    const parsed = parseJsonSafe(res.text) as FakaPlanCapacityResponse | null
    if (res.status >= 200 && res.status < 300 && parsed && parsed.success === true) {
      return wrapResult(res.status, res.text, parsed, FAKA_ERROR.UNKNOWN, true)
    }

    const errMsg =
      parsed && typeof parsed === 'object' && 'error' in parsed
        ? String((parsed as { error?: string }).error ?? '')
        : ''
    const code = classifyFakaHttpFailure(res.status, errMsg)
    return wrapResult(res.status, res.text, parsed, code, false)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const code = /timeout/i.test(msg) ? FAKA_ERROR.TIMEOUT : FAKA_ERROR.NETWORK
    return wrapFail(0, msg, code)
  }
}

/**
 * GET plan-catalog — Xboard plans for admin import (HMAC only).
 */
export async function callFakaPlanCatalog(
  overrides: FakaBridgeClientOptions = {}
): Promise<FakaHttpResult<FakaPlanCatalogResponse>> {
  const { catalogUrl, secret, timeoutMs, allowInsecure } = resolveConfig(overrides)
  if (!catalogUrl || !secret) {
    return wrapFail(0, '', FAKA_ERROR.NOT_CONFIGURED)
  }

  const paidAt = Math.floor(Date.now() / 1000)
  const signed = withFakaSignature({ paid_at: paidAt }, secret)
  const qs = new URLSearchParams({
    paid_at: String(signed.paid_at),
    sign: signed.sign,
  }).toString()
  const url = `${catalogUrl}${catalogUrl.includes('?') ? '&' : '?'}${qs}`
  const transport = overrides.transport ?? defaultFakaTransport(allowInsecure)

  try {
    const res = await transport({
      method: 'GET',
      url,
      headers: { Accept: 'application/json' },
      timeoutMs,
    })

    const parsed = parseJsonSafe(res.text) as FakaPlanCatalogResponse | null
    if (res.status >= 200 && res.status < 300 && parsed && parsed.success === true) {
      return wrapResult(res.status, res.text, parsed, FAKA_ERROR.UNKNOWN, true)
    }

    const errMsg =
      parsed && typeof parsed === 'object' && 'error' in parsed
        ? String((parsed as { error?: string }).error ?? '')
        : ''
    const code = classifyFakaHttpFailure(res.status, errMsg)
    return wrapResult(res.status, res.text, parsed, code, false)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const code = /timeout/i.test(msg) ? FAKA_ERROR.TIMEOUT : FAKA_ERROR.NETWORK
    return wrapFail(0, msg, code)
  }
}

/** Stable MoNexus → FakaBridge order_no. */
export function buildFakaExternalOrderNo(orderId: number): string {
  return `MN-${orderId}`
}
