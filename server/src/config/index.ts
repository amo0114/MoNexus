import 'dotenv/config'
import { z } from 'zod'

const booleanEnvSchema = z.preprocess(value => {
  if (value === undefined || value === '') return undefined
  if (value === 'true') return true
  if (value === 'false') return false
  return value
}, z.boolean())

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().url().refine(value => value.startsWith('postgresql://') || value.startsWith('postgres://'), {
    message: 'DATABASE_URL must be a PostgreSQL connection string',
  }),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  FRONTEND_ORIGIN: z.string().url(),
  COOKIE_SECURE: booleanEnvSchema.default(false),

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

export const config = {
  nodeEnv: env.NODE_ENV,
  isProduction: env.NODE_ENV === 'production',
  port: env.PORT,
  databaseUrl: env.DATABASE_URL,
  jwtSecret: env.JWT_SECRET,
  frontendOrigin: env.FRONTEND_ORIGIN,
  cookieSecure: env.COOKIE_SECURE,
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
}
