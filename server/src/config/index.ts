import 'dotenv/config'
import { z } from 'zod'

const booleanEnvSchema = z.preprocess(value => {
  if (value === undefined || value === '') return undefined
  if (value === 'true') return true
  if (value === 'false') return false
  return value
}, z.boolean())

const optionalUrlEnvSchema = z.preprocess(value => {
  if (value === undefined || value === '') return undefined
  return value
}, z.string().url().optional())

const optionalStringEnvSchema = z.preprocess(value => {
  if (value === undefined || value === '') return undefined
  return value
}, z.string().min(1).optional())

const redisUrlEnvSchema = z.preprocess(value => {
  if (value === undefined || value === '') return undefined
  return value
}, z.string().url().default('redis://localhost:6379'))

const optionalEmailEnvSchema = z.preprocess(value => {
  if (value === undefined || value === '') return undefined
  return value
}, z.string().email().optional())

const logLevelEnvSchema = z.preprocess(value => {
  if (value === undefined || value === '') return undefined
  return value
}, z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'))

const abuseProtectionModeEnvSchema = z.enum(['off', 'enforce']).default('off')

const CANONICAL_BASE64_32_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

/**
 * Turnstile only returns a hostname, never a URL or wildcard. Keeping the
 * production allow-list in the same canonical form makes the verifier's
 * equality check unambiguous and prevents accidental scheme/path/port input.
 */
export function normalizeHostname(value: string): string | undefined {
  if (value !== value.trim()) return undefined
  const candidate = value.toLowerCase()
  if (!candidate || /[/:?#@]/.test(candidate)) return undefined

  try {
    const parsed = new URL(`https://${candidate}`)
    if (
      parsed.hostname !== candidate
      || parsed.port
      || parsed.username
      || parsed.password
      || parsed.pathname !== '/'
      || parsed.search
      || parsed.hash
    ) {
      return undefined
    }
    return parsed.hostname
  } catch {
    return undefined
  }
}

function parseTurnstileAllowedHostnames(value: string | undefined): string[] | undefined {
  if (!value) return undefined

  const entries = value.split(',').map(entry => entry.trim())
  if (entries.length === 0 || entries.some(entry => entry.length === 0)) return undefined

  const hostnames: string[] = []
  for (const entry of entries) {
    const hostname = normalizeHostname(entry)
    if (!hostname) return undefined
    hostnames.push(hostname)
  }

  return [...new Set(hostnames)]
}

function parseCanonicalBase64Key(value: string | undefined): Buffer | undefined {
  if (!value || !CANONICAL_BASE64_32_PATTERN.test(value)) return undefined

  const key = Buffer.from(value, 'base64')
  if (key.length !== 32 || key.toString('base64') !== value) return undefined
  return key
}

/**
 * MFA seeds are encrypted with AES-256-GCM. We deliberately accept only
 * canonical RFC 4648 base64 so malformed environment values cannot silently
 * decode to a shorter key via Node's permissive Buffer decoder.
 */
function parseMfaEncryptionKey(value: string | undefined): Buffer | undefined {
  return parseCanonicalBase64Key(value)
}

/**
 * Kept separate from MFA parsing so future callers cannot accidentally reuse
 * the MFA seed-encryption material as an abuse-correlation secret.
 */
function parseAbuseHashKey(value: string | undefined): Buffer | undefined {
  return parseCanonicalBase64Key(value)
}

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().url().refine(value => value.startsWith('postgresql://') || value.startsWith('postgres://'), {
    message: 'DATABASE_URL must be a PostgreSQL connection string',
  }),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  FRONTEND_ORIGIN: z.string().url(),
  COOKIE_SECURE: booleanEnvSchema.default(false),
  MFA_ENCRYPTION_KEY: optionalStringEnvSchema,
  USER_STATUS_CACHE_TTL_SEC: z.coerce.number().int().min(0).default(60),

  // --- Global /api rate limit (requests per 15 min window per IP).
  // Default stays at 300; e2e runs override it so a full Playwright
  // suite (which shares one IP) doesn't trip the limiter mid-run.
  API_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),

  // --- Trust proxy hop count. In production behind nginx the server sees
  // requests from the proxy's internal IP; setting this to the number of
  // trusted hops lets Express parse X-Forwarded-For (set by nginx) so
  // express-rate-limit keys on the real client IP instead of treating
  // every request as coming from nginx. Accepts a non-negative integer
  // (e.g. 1 for a single nginx hop) or false to disable.
  TRUST_PROXY: z
    .preprocess(value => {
      if (value === undefined || value === '') return undefined
      if (value === 'true') return true
      if (value === 'false') return false
      return value
    }, z.union([z.coerce.number().int().min(0), z.boolean()]))
    .default(false),

  // --- Object storage (P0-C). All optional: when any are missing the
  // server falls back to an in-memory adapter that's only safe for dev
  // and tests. Production validation below enforces all-or-nothing.
  STORAGE_ENDPOINT: z.string().url().optional(),
  STORAGE_REGION: z.string().optional(),
  STORAGE_BUCKET: z.string().min(1).optional(),
  STORAGE_ACCESS_KEY: z.string().min(1).optional(),
  STORAGE_SECRET_KEY: z.string().min(1).optional(),
  STORAGE_PUBLIC_URL_BASE: z.string().url().optional(),
  STORAGE_FORCE_PATH_STYLE: booleanEnvSchema.default(true),

  // --- P5 受控文件交付的私有桶。与公开图片桶（STORAGE_BUCKET，anonymous
  // download）物理隔离；上传/删除走内网 STORAGE_ENDPOINT，签发下载 URL 用
  // DELIVERY_STORAGE_PUBLIC_ENDPOINT（浏览器可达域名，SigV4 把 Host 算进
  // 签名，两者必须一致）。未配置时回落 memory 适配器（仅 dev/test 安全）。
  DELIVERY_STORAGE_BUCKET: z.string().min(1).optional(),
  DELIVERY_STORAGE_PUBLIC_ENDPOINT: z.string().url().optional(),

  // --- SMTP for transactional email (P0-D). Optional at boot: when
  // unset, the server falls back to a console-logging mailer. Production
  // deployments should configure SMTP so password resets actually arrive.
  SMTP_HOST: optionalStringEnvSchema,
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_SECURE: booleanEnvSchema.default(false),
  SMTP_USER: optionalStringEnvSchema,
  SMTP_PASS: optionalStringEnvSchema,
  SMTP_FROM: optionalEmailEnvSchema,
  /**
   * Display name for the From: header (inbox shows e.g. "MoNexus").
   * Address stays in SMTP_FROM / SMTP_USER. Empty string = no display name.
   * Default applied below when SMTP is configured.
   */
  SMTP_FROM_NAME: optionalStringEnvSchema,

  // --- Registration abuse protection. These are deliberately independent
  // from JWT/MFA keys. `off` is only a local-development/test escape hatch;
  // production always requires enforce plus the dependent infrastructure.
  ABUSE_PROTECTION_MODE: abuseProtectionModeEnvSchema,
  ABUSE_HASH_KEY: optionalStringEnvSchema,
  TURNSTILE_SITE_KEY: optionalStringEnvSchema,
  TURNSTILE_SECRET_KEY: optionalStringEnvSchema,
  TURNSTILE_ALLOWED_HOSTNAMES: optionalStringEnvSchema,

  // --- Public app URL used to build links inside transactional emails.
  // Defaults to FRONTEND_ORIGIN if not set explicitly.
  APP_BASE_URL: optionalUrlEnvSchema,

  // --- Observability. SENTRY_DSN is optional so local/dev/test runs stay quiet.
  SENTRY_DSN: optionalUrlEnvSchema,
  LOG_LEVEL: logLevelEnvSchema,
  METRICS_TOKEN: optionalStringEnvSchema,

  // --- Redis public read cache. Disabled by default so local/test runs do
  // not need Redis unless explicitly enabled.
  REDIS_ENABLED: booleanEnvSchema.default(false),
  REDIS_URL: redisUrlEnvSchema,
  REDIS_PASSWORD: optionalStringEnvSchema,
  REDIS_TLS: booleanEnvSchema.default(false),
  REDIS_REQUIRED: booleanEnvSchema.default(false),
  REDIS_CONNECT_TIMEOUT_MS: z.coerce.number().int().positive().default(100),
  REDIS_COMMAND_TIMEOUT_MS: z.coerce.number().int().positive().default(80),
  REDIS_CIRCUIT_ERROR_THRESHOLD: z.coerce.number().int().positive().default(5),
  REDIS_CIRCUIT_OPEN_MS: z.coerce.number().int().positive().default(30_000),
  CACHE_KEY_PREFIX: z.string().min(1).default('monexus:local'),
  CACHE_PRODUCT_LIST: booleanEnvSchema.default(true),
  CACHE_PRODUCT_DETAIL: booleanEnvSchema.default(true),
  CACHE_PRODUCT_REVIEWS: booleanEnvSchema.default(true),
  CACHE_PRODUCT_LIST_VERSION_COALESCE_MS: z.coerce.number().int().min(0).default(10_000),
  CACHE_MAX_VALUE_BYTES: z.coerce.number().int().positive().default(524_288),

  // --- Portable, application-level backup/import. Files live only while an
  // administrator explicitly exports or imports a bundle.
  PORTABLE_BACKUP_WORK_DIR: z.string().min(1).default('/tmp/monexus-portable-backups'),
  PORTABLE_BACKUP_MAX_BYTES: z.coerce.number().int().positive().default(2 * 1024 * 1024 * 1024),
  PORTABLE_RESTORE_BOOTSTRAP_TOKEN: optionalStringEnvSchema,

  // --- P7b 自动开通 webhook 外呼。
  // 商家 webhook 签名密钥的静态加密密钥（AES-256-GCM，64 位 hex = 32 字节）。
  // 生产必配；dev/test 缺省时由 JWT_SECRET 派生（webhookSecret.ts）。
  WEBHOOK_SECRET_ENC_KEY: optionalStringEnvSchema,
  // 测试逃生：放开 http 与私网目标（e2e stub 接收端跑在 127.0.0.1）。
  // 生产环境为 true 时拒绝启动——这是 SSRF 防线的总开关。
  AUTO_PROVISION_ALLOW_INSECURE_TARGETS: booleanEnvSchema.default(false),

  // --- SPEC-LEGAL-001：法律页面与协议同意。ENABLED 是总开关（公开页面 +
  // 注册/下单同意采集）；ENFORCEMENT=enforce 时注册/下单必须携带当前版本
  // 的协议确认（缺 = 400 LEGAL_AGREEMENT_REQUIRED，版本旧 = 409
  // LEGAL_AGREEMENT_STALE）；off = 只记录不强求。FIXTURE_PATH 是测试逃生：
  // 指向覆盖内置五份草案的文档目录，生产拒启。
  LEGAL_PAGES_ENABLED: booleanEnvSchema.default(false),
  LEGAL_PAGES_ENFORCEMENT: z.enum(['off', 'enforce']).default('off'),
  LEGAL_PAGES_FIXTURE_PATH: optionalStringEnvSchema,

  // --- FakaBridge (Xboard subscription provision). Optional until offers use
  // externalIntegration=faka_bridge. When any of URL/SECRET is set, both must
  // be present. Production path has NO /api/v1 prefix.
  FAKA_BRIDGE_URL: optionalUrlEnvSchema,
  FAKA_BRIDGE_STATUS_URL: optionalUrlEnvSchema,
  /** Optional; defaults to order-paid URL with /order-revoke suffix. */
  FAKA_BRIDGE_REVOKE_URL: optionalUrlEnvSchema,
  FAKA_BRIDGE_SECRET: optionalStringEnvSchema,
  FAKA_BRIDGE_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
  FAKA_BRIDGE_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  // User-facing panel URL in delivery content (not the plugin webhook base).
  FAKA_BRIDGE_PANEL_URL: optionalUrlEnvSchema,
  // Test-only escape hatch. Production boot refuses true.
  FAKA_BRIDGE_ALLOW_INSECURE_TARGETS: booleanEnvSchema.default(false),
})

const parsed = envSchema.safeParse(process.env)

if (!parsed.success) {
  console.error('[Config] Invalid environment variables')
  for (const issue of parsed.error.issues) {
    console.error(`[Config] ${issue.path.join('.')}: ${issue.message}`)
  }
  process.exit(1)
}

const env = parsed.data
const mfaEncryptionKey = parseMfaEncryptionKey(env.MFA_ENCRYPTION_KEY)
const abuseHashKey = parseAbuseHashKey(env.ABUSE_HASH_KEY)
const turnstileAllowedHostnames = parseTurnstileAllowedHostnames(env.TURNSTILE_ALLOWED_HOSTNAMES)
const turnstileSiteKey = env.TURNSTILE_SITE_KEY?.trim() || undefined
const turnstileSecretKey = env.TURNSTILE_SECRET_KEY?.trim() || undefined

if (env.MFA_ENCRYPTION_KEY && !mfaEncryptionKey) {
  console.error('[Config] MFA_ENCRYPTION_KEY must be canonical base64 for exactly 32 bytes')
  process.exit(1)
}

if (env.ABUSE_HASH_KEY && !abuseHashKey) {
  console.error('[Config] ABUSE_HASH_KEY must be canonical base64 for exactly 32 bytes')
  process.exit(1)
}

if (env.TURNSTILE_ALLOWED_HOSTNAMES && !turnstileAllowedHostnames) {
  console.error('[Config] TURNSTILE_ALLOWED_HOSTNAMES must be a comma-separated list of hostnames without schemes, paths, ports, or wildcards')
  process.exit(1)
}

if (env.NODE_ENV === 'production' && !mfaEncryptionKey) {
  console.error('[Config] MFA_ENCRYPTION_KEY is required in production and must be base64 for exactly 32 bytes')
  process.exit(1)
}

if (env.NODE_ENV === 'production' && !env.COOKIE_SECURE) {
  console.error('[Config] COOKIE_SECURE must be true in production')
  process.exit(1)
}

// Registration and user-mail protection is a security dependency in
// production. Do not permit a deploy to silently start in "off" mode or to
// claim enforcement without the independent HMAC key, a real Turnstile
// verifier configuration, and a shared required Redis service.
if (env.NODE_ENV === 'production') {
  if (env.ABUSE_PROTECTION_MODE !== 'enforce') {
    console.error('[Config] ABUSE_PROTECTION_MODE must be enforce in production')
    process.exit(1)
  }
  if (!abuseHashKey) {
    console.error('[Config] ABUSE_HASH_KEY is required in production and must be base64 for exactly 32 bytes')
    process.exit(1)
  }
  if (!turnstileSiteKey || !turnstileSecretKey || !turnstileAllowedHostnames?.length) {
    console.error('[Config] TURNSTILE_SITE_KEY, TURNSTILE_SECRET_KEY, and TURNSTILE_ALLOWED_HOSTNAMES are required in production')
    process.exit(1)
  }
  if (!env.REDIS_ENABLED || !env.REDIS_REQUIRED) {
    console.error('[Config] REDIS_ENABLED and REDIS_REQUIRED must be true when ABUSE_PROTECTION_MODE=enforce in production')
    process.exit(1)
  }
}

// /api/metrics is mounted before the general API rate limiter so a missing
// token would otherwise make operational details publicly scrapeable. The
// deployment preflight checks this too, but startup validation keeps manual
// compose runs and environment drift from bypassing that safeguard.
if (env.NODE_ENV === 'production' && !env.METRICS_TOKEN) {
  console.error('[Config] METRICS_TOKEN is required in production')
  process.exit(1)
}

// Storage env vars are optional in dev/test (we fall back to in-memory
// storage) but in production all four core values must be present so we
// never silently lose user uploads to a process-local Map.
const hasAllStorageVars =
  !!env.STORAGE_ENDPOINT &&
  !!env.STORAGE_BUCKET &&
  !!env.STORAGE_ACCESS_KEY &&
  !!env.STORAGE_SECRET_KEY

if (env.NODE_ENV === 'production' && !hasAllStorageVars) {
  console.error(
    '[Config] STORAGE_ENDPOINT, STORAGE_BUCKET, STORAGE_ACCESS_KEY, and STORAGE_SECRET_KEY are all required in production'
  )
  process.exit(1)
}

// P5 私有交付桶守卫。同名意味着公开图片桶的 anonymous download 策略会波及
// 付费文件——任何环境都直接拒绝启动，而不是等到文件裸奔才发现。
if (env.DELIVERY_STORAGE_BUCKET && env.DELIVERY_STORAGE_BUCKET === env.STORAGE_BUCKET) {
  console.error(
    '[Config] DELIVERY_STORAGE_BUCKET must differ from STORAGE_BUCKET: the public bucket has an anonymous-download policy that would expose paid files'
  )
  process.exit(1)
}
// 生产必须显式配置私有交付桶：缺配置时的回退是**进程内存**——上传"成功"
// 的付费交付文件会在重启后蒸发。旧 .env 直接部署必须在启动时被挡下，
// 而不是静默降级（评审 P0-1）。
if (env.NODE_ENV === 'production') {
  if (!env.DELIVERY_STORAGE_BUCKET || !env.DELIVERY_STORAGE_PUBLIC_ENDPOINT) {
    console.error(
      '[Config] DELIVERY_STORAGE_BUCKET and DELIVERY_STORAGE_PUBLIC_ENDPOINT are required in production: without them delivery files fall back to in-memory storage and are lost on restart'
    )
    process.exit(1)
  }
  if (!hasAllStorageVars) {
    console.error('[Config] DELIVERY_STORAGE_BUCKET requires the STORAGE_* S3 variables in production')
    process.exit(1)
  }
  // presign URL 直接暴露给买家浏览器，http 意味着签名与文件内容明文可嗅探。
  // check-prod-env.sh 只覆盖 compose 预检，直接启动会绕过——必须在配置层
  // 强制（评审 P1）。
  if (new URL(env.DELIVERY_STORAGE_PUBLIC_ENDPOINT).protocol !== 'https:') {
    console.error(
      '[Config] DELIVERY_STORAGE_PUBLIC_ENDPOINT must use https in production: presigned download URLs are handed to buyer browsers'
    )
    process.exit(1)
  }
}

// Mailer: SMTP_HOST opts into real delivery. Without it, dev/test and
// intentionally-unconfigured environments use the console fallback.
const hasSmtp = !!env.SMTP_HOST
const smtpFrom = env.SMTP_FROM ?? env.SMTP_USER
if (env.NODE_ENV === 'production' && hasSmtp && !smtpFrom) {
  console.error(
    '[Config] SMTP_FROM or SMTP_USER is required when SMTP_HOST is set in production'
  )
  process.exit(1)
}

/**
 * Build RFC 5322 From with optional display name.
 * SMTP_FROM is validated as a bare email; name is a separate field so we never
 * break zod email parsing with `"Name" <addr>` in one env var.
 */
export function formatSmtpFromHeader(address: string, displayName: string | undefined): string {
  const name = displayName === undefined ? 'MoNexus' : displayName.trim()
  if (!name) return address
  const escaped = name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  return `"${escaped}" <${address}>`
}

const smtpFromHeader = smtpFrom
  ? formatSmtpFromHeader(smtpFrom, env.SMTP_FROM_NAME)
  : undefined

// P7b 自动开通外呼守卫。密钥格式任何环境都校验（错格式加密即坏数据）；
// 生产必配显式密钥（商家签名密钥静态加密不允许隐式派生），逃生开关生产拒启。
if (env.WEBHOOK_SECRET_ENC_KEY && !/^[0-9a-fA-F]{64}$/.test(env.WEBHOOK_SECRET_ENC_KEY)) {
  console.error('[Config] WEBHOOK_SECRET_ENC_KEY must be 64 hex characters (32 bytes)')
  process.exit(1)
}
if (env.NODE_ENV === 'production') {
  if (!env.WEBHOOK_SECRET_ENC_KEY) {
    console.error('[Config] WEBHOOK_SECRET_ENC_KEY is required in production (merchant webhook secrets are encrypted at rest)')
    process.exit(1)
  }
  if (env.AUTO_PROVISION_ALLOW_INSECURE_TARGETS) {
    console.error('[Config] AUTO_PROVISION_ALLOW_INSECURE_TARGETS must not be enabled in production: it disables the SSRF protections on merchant webhook calls')
    process.exit(1)
  }
}

// SPEC-LEGAL-001 守卫：enforce 但页面总开关未开是配置矛盾（会出现"必须同意
// 但用户根本读不到协议"的死锁），任何环境拒启；生产开启页面必须 enforce
// （公开页面却不采集同意 = 合规姿态形同虚设）；FIXTURE_PATH 是测试逃生，
// 生产拒启（同 AUTO_PROVISION_ALLOW_INSECURE_TARGETS 模式）。
if (env.LEGAL_PAGES_ENFORCEMENT === 'enforce' && !env.LEGAL_PAGES_ENABLED) {
  console.error('[Config] LEGAL_PAGES_ENFORCEMENT=enforce requires LEGAL_PAGES_ENABLED=true')
  process.exit(1)
}
if (env.NODE_ENV === 'production') {
  if (env.LEGAL_PAGES_ENABLED && env.LEGAL_PAGES_ENFORCEMENT !== 'enforce') {
    console.error('[Config] LEGAL_PAGES_ENFORCEMENT must be enforce in production when LEGAL_PAGES_ENABLED=true')
    process.exit(1)
  }
  if (env.LEGAL_PAGES_FIXTURE_PATH) {
    console.error('[Config] LEGAL_PAGES_FIXTURE_PATH must not be set in production: it overrides the built-in legal documents with test fixtures')
    process.exit(1)
  }
}

// FakaBridge: URL and SECRET are all-or-nothing. Status URL is optional.
const fakaUrl = env.FAKA_BRIDGE_URL
const fakaSecret = env.FAKA_BRIDGE_SECRET
const fakaPartial = Boolean(fakaUrl) !== Boolean(fakaSecret)
if (fakaPartial) {
  console.error(
    '[Config] FAKA_BRIDGE_URL and FAKA_BRIDGE_SECRET must both be set or both be unset'
  )
  process.exit(1)
}
if (env.NODE_ENV === 'production' && env.FAKA_BRIDGE_ALLOW_INSECURE_TARGETS) {
  console.error(
    '[Config] FAKA_BRIDGE_ALLOW_INSECURE_TARGETS must be false in production'
  )
  process.exit(1)
}
if (env.NODE_ENV === 'production') {
  for (const [label, raw] of [
    ['FAKA_BRIDGE_URL', fakaUrl],
    ['FAKA_BRIDGE_STATUS_URL', env.FAKA_BRIDGE_STATUS_URL],
    ['FAKA_BRIDGE_REVOKE_URL', env.FAKA_BRIDGE_REVOKE_URL],
  ] as const) {
    if (!raw) continue
    try {
      const u = new URL(raw)
      if (u.protocol !== 'https:') {
        console.error(`[Config] ${label} must use https in production`)
        process.exit(1)
      }
    } catch {
      console.error(`[Config] ${label} is not a valid URL`)
      process.exit(1)
    }
  }
}

const fakaBridgeEnabled = Boolean(fakaUrl && fakaSecret)

export const config = {
  nodeEnv: env.NODE_ENV,
  isProduction: env.NODE_ENV === 'production',
  port: env.PORT,
  databaseUrl: env.DATABASE_URL,
  jwtSecret: env.JWT_SECRET,
  frontendOrigin: env.FRONTEND_ORIGIN,
  cookieSecure: env.COOKIE_SECURE,
  mfaEncryptionKey,
  userStatusCacheTtlSec: env.USER_STATUS_CACHE_TTL_SEC,
  apiRateLimitMax: env.API_RATE_LIMIT_MAX,
  trustProxy: env.TRUST_PROXY,
  jwtExpiresIn: '15m' as const,
  refreshTokenMaxAgeMs: 7 * 24 * 60 * 60 * 1000,
  checkinReward: 50,
  registerReward: 500,
  inviteReward: 200,
  storage: hasAllStorageVars
    ? {
        kind: 's3' as const,
        endpoint: env.STORAGE_ENDPOINT!,
        region: env.STORAGE_REGION ?? 'us-east-1',
        bucket: env.STORAGE_BUCKET!,
        accessKey: env.STORAGE_ACCESS_KEY!,
        secretKey: env.STORAGE_SECRET_KEY!,
        publicUrlBase: env.STORAGE_PUBLIC_URL_BASE,
        forcePathStyle: env.STORAGE_FORCE_PATH_STYLE,
      }
    : ({ kind: 'memory' as const }),
  deliveryStorage: hasAllStorageVars && env.DELIVERY_STORAGE_BUCKET
    ? {
        kind: 's3' as const,
        endpoint: env.STORAGE_ENDPOINT!,
        region: env.STORAGE_REGION ?? 'us-east-1',
        bucket: env.DELIVERY_STORAGE_BUCKET,
        accessKey: env.STORAGE_ACCESS_KEY!,
        secretKey: env.STORAGE_SECRET_KEY!,
        // 浏览器可达域名；缺省回落内网 endpoint（仅本机直连 MinIO 的场景可用）。
        publicEndpoint: env.DELIVERY_STORAGE_PUBLIC_ENDPOINT ?? env.STORAGE_ENDPOINT!,
        forcePathStyle: env.STORAGE_FORCE_PATH_STYLE,
      }
    : ({ kind: 'memory' as const }),
  mailer: hasSmtp
    ? {
        kind: 'smtp' as const,
        host: env.SMTP_HOST!,
        port: env.SMTP_PORT,
        secure: env.SMTP_SECURE,
        user: env.SMTP_USER,
        pass: env.SMTP_PASS,
        // 实际生效 From 头：含显示名 + 地址（SMTP_FROM ?? SMTP_USER）。
        // 驱动真实投递；Boolean(from) 仍可用于 deliveryReady。
        from: smtpFromHeader,
        // 可展示发件地址：仅显式 SMTP_FROM 邮箱本体，不回显显示名/SMTP_USER。
        displayFrom: env.SMTP_FROM,
      }
    : ({ kind: 'console' as const }),
  abuseProtectionMode: env.ABUSE_PROTECTION_MODE,
  abuseHashKey,
  turnstile: {
    siteKey: turnstileSiteKey,
    secretKey: turnstileSecretKey,
    allowedHostnames: turnstileAllowedHostnames ?? [],
  },
  appBaseUrl: env.APP_BASE_URL ?? env.FRONTEND_ORIGIN,
  sentryDsn: env.SENTRY_DSN,
  logLevel: env.LOG_LEVEL,
  metricsToken: env.METRICS_TOKEN,
  redisEnabled: env.REDIS_ENABLED,
  redisUrl: env.REDIS_URL,
  redisPassword: env.REDIS_PASSWORD,
  redisTls: env.REDIS_TLS,
  redisRequired: env.REDIS_REQUIRED,
  redisConnectTimeoutMs: env.REDIS_CONNECT_TIMEOUT_MS,
  redisCommandTimeoutMs: env.REDIS_COMMAND_TIMEOUT_MS,
  redisCircuitErrorThreshold: env.REDIS_CIRCUIT_ERROR_THRESHOLD,
  redisCircuitOpenMs: env.REDIS_CIRCUIT_OPEN_MS,
  cacheKeyPrefix: env.CACHE_KEY_PREFIX,
  cacheProductList: env.CACHE_PRODUCT_LIST,
  cacheProductDetail: env.CACHE_PRODUCT_DETAIL,
  cacheProductReviews: env.CACHE_PRODUCT_REVIEWS,
  cacheProductListVersionCoalesceMs: env.CACHE_PRODUCT_LIST_VERSION_COALESCE_MS,
  cacheMaxValueBytes: env.CACHE_MAX_VALUE_BYTES,
  portableBackupWorkDir: env.PORTABLE_BACKUP_WORK_DIR,
  portableBackupMaxBytes: env.PORTABLE_BACKUP_MAX_BYTES,
  portableRestoreBootstrapToken: env.PORTABLE_RESTORE_BOOTSTRAP_TOKEN,
  passwordResetTokenMaxAgeMs: 30 * 60 * 1000, // 30 min
  emailVerificationTokenMaxAgeMs: 24 * 60 * 60 * 1000, // 24h
  // P7b 自动开通：null = 未显式配置（dev/test 由 JWT_SECRET 派生）。
  webhookSecretEncKey: env.WEBHOOK_SECRET_ENC_KEY ?? null,
  autoProvisionAllowInsecureTargets: env.AUTO_PROVISION_ALLOW_INSECURE_TARGETS,
  legalPages: {
    enabled: env.LEGAL_PAGES_ENABLED,
    enforcement: env.LEGAL_PAGES_ENFORCEMENT,
    fixturePath: env.LEGAL_PAGES_FIXTURE_PATH,
  },
  fakaBridge: fakaBridgeEnabled
    ? {
        enabled: true as const,
        url: fakaUrl!,
        statusUrl: env.FAKA_BRIDGE_STATUS_URL,
        revokeUrl: env.FAKA_BRIDGE_REVOKE_URL,
        secret: fakaSecret!,
        timeoutMs: env.FAKA_BRIDGE_TIMEOUT_MS,
        maxAttempts: env.FAKA_BRIDGE_MAX_ATTEMPTS,
        allowInsecureTargets: env.FAKA_BRIDGE_ALLOW_INSECURE_TARGETS,
        panelUrl: env.FAKA_BRIDGE_PANEL_URL ?? 'https://v.uuwu.de',
      }
    : {
        enabled: false as const,
        url: undefined,
        statusUrl: undefined,
        revokeUrl: undefined,
        secret: undefined,
        timeoutMs: env.FAKA_BRIDGE_TIMEOUT_MS,
        maxAttempts: env.FAKA_BRIDGE_MAX_ATTEMPTS,
        allowInsecureTargets: env.FAKA_BRIDGE_ALLOW_INSECURE_TARGETS,
        panelUrl: env.FAKA_BRIDGE_PANEL_URL ?? 'https://v.uuwu.de',
      },
}
