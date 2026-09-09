import { config } from '../config/index.js'

export const SHORTLINK_REMOTE_BUDGET_MS = 8_000
export const SHORTLINK_DESCRIBE = 'MoNexus 商品分享'
export const SHORTLINK_LOGIN_PATH = '/api/short-link/admin/v1/user/login'
export const SHORTLINK_CREATE_PATH = '/api/short-link/admin/v1/create'

const SHORT_CODE_PATH = /^\/[A-Za-z0-9]{1,64}$/

export class ShortlinkError extends Error {
  readonly kind: 'unconfigured' | 'timeout' | 'unavailable'

  constructor(kind: 'unconfigured' | 'timeout' | 'unavailable' = 'unavailable') {
    super('shortlink unavailable')
    this.name = 'ShortlinkError'
    this.kind = kind
  }
}

export type ShortlinkConfig = {
  apiBaseUrl: string
  publicOrigin: string
  username: string
  password: string
  groupId: string
}

export type ShortlinkCreateResult = {
  url: string
}

export type ShortlinkClient = {
  createShortLink: (originUrl: string) => Promise<ShortlinkCreateResult>
}

export type ShortlinkClientOptions = {
  config?: ShortlinkConfig
  fetchImplementation?: typeof fetch
  remoteBudgetMs?: number
}

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isAbortError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  return err.name === 'AbortError' || err.name === 'TimeoutError' || err.name === 'DOMException'
}

function isHttp2xx(status: number): boolean {
  return status >= 200 && status < 300
}

function joinOriginPath(origin: string, path: string): string {
  return `${origin.replace(/\/$/, '')}${path}`
}

export function isShortlinkConfigured(
  source: Partial<ShortlinkConfig> & { enabled?: boolean } = config.shortlink,
): source is ShortlinkConfig {
  return Boolean(
    source.apiBaseUrl
    && source.publicOrigin
    && source.username
    && source.password
    && source.groupId,
  )
}

export function toPublicShortUrl(fullShortUrl: string, publicOrigin: string): string | null {
  let returned: URL
  let origin: URL
  try {
    returned = new URL(fullShortUrl)
    origin = new URL(publicOrigin)
  } catch {
    return null
  }
  if (origin.protocol !== 'https:') return null
  if (returned.username || returned.password || returned.search || returned.hash) return null
  if (returned.hostname.toLowerCase() !== origin.hostname.toLowerCase()) return null
  if (returned.port !== origin.port) return null
  if (!SHORT_CODE_PATH.test(returned.pathname)) return null
  return `${origin.origin}${returned.pathname}`
}

function resolveConfig(options: ShortlinkClientOptions): ShortlinkConfig | undefined {
  if (options.config) return isShortlinkConfigured(options.config) ? options.config : undefined
  return isShortlinkConfigured() ? {
    apiBaseUrl: config.shortlink.apiBaseUrl!,
    publicOrigin: config.shortlink.publicOrigin!,
    username: config.shortlink.username!,
    password: config.shortlink.password!,
    groupId: config.shortlink.groupId!,
  } : undefined
}

export function createShortlinkClient(options: ShortlinkClientOptions = {}): ShortlinkClient {
  const cfg = resolveConfig(options)
  const fetchImplementation = options.fetchImplementation ?? globalThis.fetch
  const budgetMs = options.remoteBudgetMs ?? SHORTLINK_REMOTE_BUDGET_MS

  let cachedToken: string | null = null
  let loginInFlight: Promise<string> | null = null

  async function postJson(
    url: string,
    body: unknown,
    deadlineAt: number,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; json: unknown }> {
    const remaining = deadlineAt - Date.now()
    if (remaining <= 0) throw new ShortlinkError('timeout')

    let response: Response
    try {
      response = await fetchImplementation(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(remaining),
        redirect: 'manual',
      })
    } catch (err) {
      if (isAbortError(err)) throw new ShortlinkError('timeout')
      throw new ShortlinkError('unavailable')
    }

    let json: unknown = null
    try {
      const text = await response.text()
      json = text ? JSON.parse(text) as unknown : null
    } catch {
      json = null
    }
    return { status: response.status, json }
  }

  async function login(deadlineAt: number): Promise<string> {
    if (cachedToken) return cachedToken
    if (loginInFlight) return loginInFlight
    if (!cfg) throw new ShortlinkError('unconfigured')

    loginInFlight = (async () => {
      const { status, json } = await postJson(
        joinOriginPath(cfg.apiBaseUrl, SHORTLINK_LOGIN_PATH),
        { username: cfg.username, password: cfg.password },
        deadlineAt,
      )
      if (!isHttp2xx(status) || !isRecord(json) || json.code !== '0' || !isRecord(json.data)) {
        throw new ShortlinkError('unavailable')
      }
      const token = json.data.token
      if (typeof token !== 'string' || token.length === 0) {
        throw new ShortlinkError('unavailable')
      }
      cachedToken = token
      return token
    })().finally(() => {
      loginInFlight = null
    })

    return loginInFlight
  }

  async function createOnce(
    originUrl: string,
    token: string,
    deadlineAt: number,
  ): Promise<{ status: number; json: unknown }> {
    if (!cfg) throw new ShortlinkError('unconfigured')
    return postJson(
      joinOriginPath(cfg.apiBaseUrl, SHORTLINK_CREATE_PATH),
      {
        originUrl,
        gid: cfg.groupId,
        createdType: 0,
        validDateType: 0,
        validDate: null,
        describe: SHORTLINK_DESCRIBE,
      },
      deadlineAt,
      { username: cfg.username, token },
    )
  }

  function parseCreateResult(json: unknown, originUrl: string): ShortlinkCreateResult {
    if (!cfg) throw new ShortlinkError('unconfigured')
    if (!isRecord(json) || json.code !== '0' || !isRecord(json.data)) {
      throw new ShortlinkError('unavailable')
    }
    const { fullShortUrl, originUrl: returnedOrigin, gid } = json.data
    if (
      typeof fullShortUrl !== 'string'
      || typeof returnedOrigin !== 'string'
      || typeof gid !== 'string'
      || returnedOrigin !== originUrl
      || gid !== cfg.groupId
    ) {
      throw new ShortlinkError('unavailable')
    }
    const url = toPublicShortUrl(fullShortUrl, cfg.publicOrigin)
    if (!url) throw new ShortlinkError('unavailable')
    return { url }
  }

  return {
    async createShortLink(originUrl: string): Promise<ShortlinkCreateResult> {
      if (!cfg || typeof fetchImplementation !== 'function') {
        throw new ShortlinkError('unconfigured')
      }
      const deadlineAt = Date.now() + budgetMs
      const token = await login(deadlineAt)
      let response = await createOnce(originUrl, token, deadlineAt)
      if (response.status === 401) {
        cachedToken = null
        const refreshed = await login(deadlineAt)
        response = await createOnce(originUrl, refreshed, deadlineAt)
      }
      if (!isHttp2xx(response.status)) throw new ShortlinkError('unavailable')
      return parseCreateResult(response.json, originUrl)
    },
  }
}

let defaultClient: ShortlinkClient | null = null

export function getShortlinkClient(): ShortlinkClient | null {
  if (!isShortlinkConfigured()) return null
  if (!defaultClient) defaultClient = createShortlinkClient()
  return defaultClient
}
