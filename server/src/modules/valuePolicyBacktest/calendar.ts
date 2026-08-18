import { BacktestError, BACKTEST_ERROR_CODES } from './errors.js'

const ISO_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/

export function parseStrictUtcInstant(raw: string): Date {
  const match = ISO_INSTANT.exec(raw)
  if (!match) {
    throw new BacktestError(BACKTEST_ERROR_CODES.INVALID_PERIOD, 'period timestamp must be a UTC instant')
  }
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = Number(match[4])
  const minute = Number(match[5])
  const second = Number(match[6])
  const millisecond = Number((match[7] ?? '0').padEnd(3, '0'))
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) {
    throw new BacktestError(BACKTEST_ERROR_CODES.INVALID_PERIOD, 'period timestamp is not a real calendar instant')
  }
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second, millisecond))
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
    || date.getUTCHours() !== hour
    || date.getUTCMinutes() !== minute
    || date.getUTCSeconds() !== second
    || date.getUTCMilliseconds() !== millisecond
  ) {
    throw new BacktestError(BACKTEST_ERROR_CODES.INVALID_PERIOD, 'period timestamp is not a real calendar instant')
  }
  return date
}
