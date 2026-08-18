import { createHash } from 'node:crypto'
import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { parseStrictUtcInstant } from './calendar.js'
import { BacktestError, BACKTEST_ERROR_CODES } from './errors.js'
import { assertKnownSchemaVersion, backtestInputSchema, firstZodBacktestCode } from './schema.js'
import { INPUT_LIMITS } from './thresholds.js'
import type {
  BacktestAccount,
  BacktestMonthlyActivity,
  BacktestOffer,
  BacktestOrder,
  ValidatedInput,
} from './types.js'

function utcMonthKey(date: Date): string {
  const year = date.getUTCFullYear()
  const month = date.getUTCMonth() + 1
  return `${year.toString(10)}-${month.toString(10).padStart(2, '0')}`
}

export function monthsInclusive(from: Date, to: Date): string[] {
  const months: string[] = []
  const cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1))
  const end = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), 1))
  while (cursor.getTime() <= end.getTime()) {
    months.push(utcMonthKey(cursor))
    cursor.setUTCMonth(cursor.getUTCMonth() + 1)
  }
  return months
}

function parseAmount(raw: string): bigint {
  return BigInt(raw)
}

export function hashBufferSha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

export function parseBacktestInput(rawText: string, rawSha256: string, byteLength: number): ValidatedInput {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawText) as unknown
  } catch {
    throw new BacktestError(BACKTEST_ERROR_CODES.INVALID_JSON, 'input is not valid JSON')
  }

  assertKnownSchemaVersion(parsed)

  const result = backtestInputSchema.safeParse(parsed)
  if (!result.success) {
    const mapped = firstZodBacktestCode(result.error.issues)
    if (mapped) {
      throw new BacktestError(mapped.code as typeof BACKTEST_ERROR_CODES[keyof typeof BACKTEST_ERROR_CODES], 'input failed schema validation', {
        path: mapped.path,
      })
    }
    throw new BacktestError(BACKTEST_ERROR_CODES.INPUT_INCONSISTENT, 'input failed schema validation')
  }

  const data = result.data
  const from = parseStrictUtcInstant(data.period.from)
  const to = parseStrictUtcInstant(data.period.to)
  if (from.getTime() >= to.getTime()) {
    throw new BacktestError(BACKTEST_ERROR_CODES.INVALID_PERIOD, 'period.from must be strictly before period.to')
  }

  if (data.offers.length > INPUT_LIMITS.maxOffers
    || data.accounts.length > INPUT_LIMITS.maxAccounts
    || data.monthlyActivity.length > INPUT_LIMITS.maxMonthlyActivity
    || data.orders.length > INPUT_LIMITS.maxOrders) {
    throw new BacktestError(BACKTEST_ERROR_CODES.TOO_MANY_ROWS, 'input exceeds documented row limits')
  }

  const months = monthsInclusive(from, to)
  const monthSet = new Set(months)

  const offerRefs = new Set<string>()
  const offers: BacktestOffer[] = []
  for (let index = 0; index < data.offers.length; index += 1) {
    const row = data.offers[index]
    if (offerRefs.has(row.offerRef)) {
      throw new BacktestError(BACKTEST_ERROR_CODES.DUPLICATE_REF, 'duplicate offerRef', { path: `offers[${index}]` })
    }
    offerRefs.add(row.offerRef)
    offers.push({
      offerRef: row.offerRef,
      category: row.category,
      pricePoints: parseAmount(row.pricePoints),
      merchantCostCnyAtomic: row.merchantCostCnyAtomic === undefined
        ? null
        : parseAmount(row.merchantCostCnyAtomic),
    })
  }

  const accountRefs = new Set<string>()
  const accounts: BacktestAccount[] = []
  for (let index = 0; index < data.accounts.length; index += 1) {
    const row = data.accounts[index]
    if (accountRefs.has(row.accountRef)) {
      throw new BacktestError(BACKTEST_ERROR_CODES.DUPLICATE_REF, 'duplicate accountRef', { path: `accounts[${index}]` })
    }
    accountRefs.add(row.accountRef)
    accounts.push({
      accountRef: row.accountRef,
      balancePoints: parseAmount(row.balancePoints),
      frozenPoints: parseAmount(row.frozenPoints),
    })
  }

  const activityKeys = new Set<string>()
  const monthlyActivity: BacktestMonthlyActivity[] = []
  for (let index = 0; index < data.monthlyActivity.length; index += 1) {
    const row = data.monthlyActivity[index]
    if (!monthSet.has(row.month)) {
      throw new BacktestError(BACKTEST_ERROR_CODES.INVALID_MONTH, 'monthlyActivity month is outside period', {
        path: `monthlyActivity[${index}]`,
      })
    }
    const key = `${row.month}\0${row.accountRef}`
    if (activityKeys.has(key)) {
      throw new BacktestError(BACKTEST_ERROR_CODES.DUPLICATE_REF, 'duplicate monthlyActivity row', {
        path: `monthlyActivity[${index}]`,
      })
    }
    activityKeys.add(key)
    if (!accountRefs.has(row.accountRef)) {
      throw new BacktestError(BACKTEST_ERROR_CODES.ORPHAN_ACCOUNT_REF, 'monthlyActivity references an unknown account', {
        path: `monthlyActivity[${index}]`,
      })
    }
    monthlyActivity.push({
      month: row.month,
      accountRef: row.accountRef,
      earnedPoints: parseAmount(row.earnedPoints),
      spentPoints: parseAmount(row.spentPoints),
      expiredPoints: parseAmount(row.expiredPoints),
      refundedPoints: parseAmount(row.refundedPoints),
    })
  }

  const orderRefs = new Set<string>()
  const orders: BacktestOrder[] = []
  for (let index = 0; index < data.orders.length; index += 1) {
    const row = data.orders[index]
    if (orderRefs.has(row.orderRef)) {
      throw new BacktestError(BACKTEST_ERROR_CODES.DUPLICATE_REF, 'duplicate orderRef', { path: `orders[${index}]` })
    }
    orderRefs.add(row.orderRef)
    if (!offerRefs.has(row.offerRef)) {
      throw new BacktestError(BACKTEST_ERROR_CODES.ORPHAN_OFFER_REF, 'order references an unknown offer', {
        path: `orders[${index}]`,
      })
    }
    if (row.accountRef !== undefined && !accountRefs.has(row.accountRef)) {
      throw new BacktestError(BACKTEST_ERROR_CODES.ORPHAN_ACCOUNT_REF, 'order references an unknown account', {
        path: `orders[${index}]`,
      })
    }
    orders.push({
      orderRef: row.orderRef,
      offerRef: row.offerRef,
      accountRef: row.accountRef ?? null,
      points: parseAmount(row.points),
      status: row.status,
    })
  }

  return {
    schemaVersion: 1,
    period: {
      from: data.period.from,
      to: data.period.to,
      fromMs: from.getTime(),
      toMs: to.getTime(),
      months,
    },
    offers,
    accounts,
    monthlyActivity,
    orders,
    rawSha256,
    byteLength,
  }
}

export function readFromSyncReader(
  readChunk: (buffer: Buffer) => number,
  maxBytes: number,
): Buffer {
  const chunks: Buffer[] = []
  let total = 0
  const buffer = Buffer.alloc(Math.min(64 * 1024, maxBytes + 1))
  while (true) {
    const bytes = readChunk(buffer)
    if (bytes === 0) {
      break
    }
    total += bytes
    if (total > maxBytes) {
      throw new BacktestError(BACKTEST_ERROR_CODES.FILE_TOO_LARGE, 'input file exceeds the documented size limit', {
        maxFileBytes: maxBytes,
      })
    }
    chunks.push(Buffer.from(buffer.subarray(0, bytes)))
  }
  if (chunks.length === 0) {
    return Buffer.alloc(0)
  }
  return chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, total)
}

export function readCappedFileSync(inputPath: string, maxBytes = INPUT_LIMITS.maxFileBytes): Buffer {
  let fd: number
  try {
    fd = openSync(inputPath, 'r')
  } catch {
    throw new BacktestError(BACKTEST_ERROR_CODES.MISSING_INPUT, 'input file does not exist')
  }
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile()) {
      throw new BacktestError(BACKTEST_ERROR_CODES.MISSING_INPUT, 'input path is not a file')
    }
    if (stat.size > maxBytes) {
      throw new BacktestError(BACKTEST_ERROR_CODES.FILE_TOO_LARGE, 'input file exceeds the documented size limit', {
        maxFileBytes: maxBytes,
      })
    }
    return readFromSyncReader(chunk => readSync(fd, chunk, 0, chunk.length, null), maxBytes)
  } finally {
    closeSync(fd)
  }
}

export function readAndParseInputFile(inputPath: string): ValidatedInput {
  const buffer = readCappedFileSync(inputPath)
  return parseBacktestInput(buffer.toString('utf8'), hashBufferSha256(buffer), buffer.byteLength)
}
