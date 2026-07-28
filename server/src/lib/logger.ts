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
    ...MFA_SENSITIVE_FIELDS.flatMap(nestedSensitivePaths),
    ...MFA_FACTOR_CODE_BODY_PATHS,
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
