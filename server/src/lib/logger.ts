import pino from 'pino'
import { config } from '../config/index.js'

export const logger = pino({
  level: config.logLevel,
  enabled: config.nodeEnv !== 'test',
  base: undefined,
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      '*.password',
      '*.token',
      '*.accessToken',
      '*.refreshToken',
      '*.redisUrl',
      '*.REDIS_URL',
      'redisUrl',
      'REDIS_URL',
      '*.deliveryCredentials',
      '*.credentials',
    ],
    censor: '[redacted]',
  },
})
