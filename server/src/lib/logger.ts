import pino from 'pino'
import { config } from '../config/index.js'

/**
 * Keep MFA-specific redaction exact rather than redacting every `secret` or
 * arbitrary request field. The same field names are covered at the log root,
 * under structured request data, and under common nested error containers.
 */
const MFA_SENSITIVE_FIELDS = [
  'password',
  'verificationPassword',
  'currentPassword',
  'newPassword',
  'mfaCode',
  'recoveryCode',
  'recoveryCodes',
  'challengeId',
  'manualKey',
  'provisioningUri',
  'mfaSecret',
  'mfaSecretEncrypted',
  'pendingSecret',
  // AuthChallenge stores an encrypted pending seed under this exact column.
  // It is still credential material and must never enter a structured log.
  'secretEncrypted',
  'MFA_ENCRYPTION_KEY',
  'mfaEncryptionKey',
] as const

/**
 * MFA confirm/verify intentionally use the neutral API field name `code`.
 * Do not redact every logged `code`: application error codes are useful
 * diagnostics. Redact it only where it is request/error-body credential data.
 */
const MFA_FACTOR_CODE_BODY_PATHS = [
  'req.body.code',
  'req.body[*].code',
  'req.body.*.code',
  'request.body.code',
  'request.body[*].code',
  'request.body.*.code',
  'err.body.code',
  'err.body[*].code',
  'err.body.*.code',
  'error.body.code',
  'error.body[*].code',
  'error.body.*.code',
  'err.cause.body.code',
  'err.cause.body[*].code',
  'err.cause.body.*.code',
  'error.cause.body.code',
  'error.cause.body[*].code',
  'error.cause.body.*.code',
  'err.context.body.code',
  'err.context.body[*].code',
  'err.context.body.*.code',
  'error.context.body.code',
  'error.context.body[*].code',
  'error.context.body.*.code',
] as const

function nestedSensitivePaths(field: string) {
  return [
    field,
    `*.${field}`,
    `*.body.${field}`,
    `*.body[*].${field}`,
    `*.body.*.${field}`,
    `*.query.${field}`,
    `*.params.${field}`,
    `*.cause.${field}`,
    `*.cause.body.${field}`,
    `*.cause.context.${field}`,
    `*.cause.*.${field}`,
    `*.cause.*.body.${field}`,
    `*.context.${field}`,
    `*.context.body.${field}`,
    `*.context.*.${field}`,
    `*.context.*.body.${field}`,
  ]
}

/**
 * Registration abuse-protection credentials and proofs. `turnstileToken` is
 * an ephemeral bearer proof, not an application error code; keep this list
 * exact so useful fixed `code` fields remain visible in operational logs.
 */
const ABUSE_PROTECTION_SENSITIVE_FIELDS = [
  'turnstileToken',
  'cf-turnstile-response',
  'TURNSTILE_SECRET_KEY',
  'ABUSE_HASH_KEY',
  'turnstileSecretKey',
  'abuseHashKey',
  'emailVerificationToken',
  'passwordResetToken',
  'verificationToken',
  'resetToken',
] as const

/**
 * Provider request/response containers may include a Turnstile proof or
 * provider-specific failure payload. Redact the complete bounded container
 * rather than trying to maintain a fragile allow-list of provider fields.
 */
const TURNSTILE_SITEVERIFY_PATHS = [
  ...nestedSensitivePaths('siteverify'),
  ...nestedSensitivePaths('turnstileSiteverify'),
  'turnstile.secretKey',
  '*.turnstile.secretKey',
  '*.context.turnstile.secretKey',
  '*.cause.turnstile.secretKey',
  'turnstile.request.body',
  'turnstile.response.body',
  '*.turnstile.request.body',
  '*.turnstile.response.body',
  '*.context.turnstile.request.body',
  '*.context.turnstile.response.body',
  '*.cause.turnstile.request.body',
  '*.cause.turnstile.response.body',
] as const

/**
 * SMTP 凭证。刻意逐条列出而不是泛化 `user`/`pass`：`user` 在业务日志里是
 * 高频的非敏感字段（`req.user`、`user.id` 等），整体 redact 会把有用的诊断
 * 信息一起抹掉。这里只覆盖凭证真正出现的三种容器——原始环境变量名、
 * `config.mailer` 结构、以及 nodemailer 的 `auth: { user, pass }`。
 */
const SMTP_CREDENTIAL_PATHS = [
  'SMTP_USER',
  'SMTP_PASS',
  '*.SMTP_USER',
  '*.SMTP_PASS',
  '*.*.SMTP_USER',
  '*.*.SMTP_PASS',
  'mailer.user',
  'mailer.pass',
  '*.mailer.user',
  '*.mailer.pass',
  '*.*.mailer.user',
  '*.*.mailer.pass',
  'auth.user',
  'auth.pass',
  '*.auth.user',
  '*.auth.pass',
  '*.*.auth.user',
  '*.*.auth.pass',
] as const

/** Exported for direct serialization tests; do not derive paths from input. */
export const loggerRedact: pino.redactOptions = {
  paths: [
    'req.headers.authorization',
    'req.headers.cookie',
    'req.headers["x-api-key"]',
    'authorization',
    'cookie',
    'token',
    'accessToken',
    'refreshToken',
    'redisUrl',
    'REDIS_URL',
    'deliveryCredentials',
    'credentials',
    '*.token',
    '*.accessToken',
    '*.refreshToken',
    '*.redisUrl',
    '*.REDIS_URL',
    '*.deliveryCredentials',
    '*.credentials',
    ...SMTP_CREDENTIAL_PATHS,
    ...MFA_SENSITIVE_FIELDS.flatMap(nestedSensitivePaths),
    ...MFA_FACTOR_CODE_BODY_PATHS,
    ...ABUSE_PROTECTION_SENSITIVE_FIELDS.flatMap(nestedSensitivePaths),
    ...TURNSTILE_SITEVERIFY_PATHS,
  ],
  censor: '[redacted]',
}

export const logger = pino({
  level: config.logLevel,
  enabled: config.nodeEnv !== 'test',
  base: undefined,
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: loggerRedact,
})
