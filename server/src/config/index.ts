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

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().url().refine(value => value.startsWith('postgresql://') || value.startsWith('postgres://'), {
    message: 'DATABASE_URL must be a PostgreSQL connection string',
  }),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  FRONTEND_ORIGIN: z.string().url(),
  COOKIE_SECURE: booleanEnvSchema.default(false),
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

if (env.NODE_ENV === 'production' && !env.COOKIE_SECURE) {
  console.error('[Config] COOKIE_SECURE must be true in production')
  process.exit(1)
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

export const config = {
  nodeEnv: env.NODE_ENV,
  isProduction: env.NODE_ENV === 'production',
  port: env.PORT,
  databaseUrl: env.DATABASE_URL,
  jwtSecret: env.JWT_SECRET,
  frontendOrigin: env.FRONTEND_ORIGIN,
  cookieSecure: env.COOKIE_SECURE,
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
        from: smtpFrom,
      }
    : ({ kind: 'console' as const }),
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
}
