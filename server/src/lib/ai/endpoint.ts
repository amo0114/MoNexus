import { lookup } from 'node:dns'
import type { LookupAddress } from 'node:dns'
import { isIP } from 'node:net'
import { Agent } from 'undici'
import { badRequest } from '../httpError.js'
import { isPubliclyRoutableIp } from '../outboundWebhook.js'

export const DEFAULT_AI_BASE_URL = 'https://api.openai.com/v1'
export const DEFAULT_AI_MODEL = 'gpt-6-luna'

export function normalizeAiBaseUrl(value: string): string {
  let url: URL
  try { url = new URL(value.trim()) } catch { throw badRequest('API 地址格式不正确') }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw badRequest('API 地址必须使用 HTTPS，且不能携带账号、密码、查询参数或片段')
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost') || (isIP(host) && !isPubliclyRoutableIp(host))) {
    throw badRequest('API 地址不能指向本机、内网或保留地址')
  }
  return url.toString().replace(/\/+$/, '')
}

/** Validate at the actual socket lookup, preventing DNS rebinding between validation and connection. */
export function lookupAiEndpoint(
  hostname: string,
  options: { all?: boolean },
  callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
): void {
  lookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
    if (err) return callback(new Error('AI endpoint DNS lookup failed'), '')
    if (!addresses.length || addresses.some(a => !isPubliclyRoutableIp(a.address))) {
      return callback(new Error('AI endpoint resolves to a blocked address'), '')
    }
    if (options.all) return callback(null, addresses)
    callback(null, addresses[0].address, addresses[0].family)
  })
}

const dispatcher = new Agent({ connect: { lookup: lookupAiEndpoint as never } })

export function createAiFetch(baseUrl: string): typeof globalThis.fetch {
  const normalized = normalizeAiBaseUrl(baseUrl)
  const base = new URL(normalized)
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    normalizeAiBaseUrl(url.toString())
    if (url.origin !== base.origin || !url.pathname.startsWith(`${base.pathname.replace(/\/+$/, '')}/`)) {
      throw new Error('AI request target differs from configured endpoint')
    }
    const options = { ...init, dispatcher, redirect: 'error' as const }
    return globalThis.fetch(input, options)
  }
}
