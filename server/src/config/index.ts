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
  passwordResetTokenMaxAgeMs: 30 * 60 * 1000, // 30 min
  emailVerificationTokenMaxAgeMs: 24 * 60 * 60 * 1000, // 24h
}
