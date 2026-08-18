import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { buildSyntheticSmallInput, syntheticRef } from './__fixtures__/syntheticSmall.js'
import { BACKTEST_ERROR_CODES, BacktestError } from './errors.js'
import { hashBufferSha256, parseBacktestInput, readAndParseInputFile } from './parse.js'
import { INPUT_LIMITS } from './thresholds.js'

function parseJson(value: unknown) {
  const raw = `${JSON.stringify(value)}\n`
  return parseBacktestInput(raw, hashBufferSha256(Buffer.from(raw)), Buffer.byteLength(raw))
}

describe('backtest input schema', () => {
  it('accepts the synthetic fixture', () => {
    const parsed = parseJson(buildSyntheticSmallInput())
    expect(parsed.schemaVersion).toBe(1)
    expect(parsed.offers).toHaveLength(17)
    expect(parsed.accounts).toHaveLength(12)
    expect(parsed.period.months).toEqual(['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06'])
  })

  it('accepts the committed synthetic JSON file', () => {
    const fixturePath = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'synthetic-small.json')
    const raw = readFileSync(fixturePath)
    const parsed = parseBacktestInput(raw.toString('utf8'), hashBufferSha256(raw), raw.byteLength)
    expect(parsed.offers).toHaveLength(17)
    expect(parsed.accounts.some(account => account.frozenPoints > 0n)).toBe(true)
    expect(parsed.monthlyActivity.some(row => row.refundedPoints > 0n)).toBe(true)
    expect(parsed.monthlyActivity.some(row => row.spentPoints === 0n)).toBe(true)
    expect(parsed.offers.some(offer => offer.merchantCostCnyAtomic === null)).toBe(true)
    expect(parsed.offers.some(offer => offer.pricePoints % 2n === 1n)).toBe(true)
  })

  it('rejects JSON number amounts', () => {
    const input = buildSyntheticSmallInput()
    ;(input.offers[0] as { pricePoints: unknown }).pricePoints = 1200
    expect(() => parseJson(input)).toThrow(BacktestError)
    try {
      parseJson(input)
    } catch (error) {
      expect(error).toBeInstanceOf(BacktestError)
      expect((error as BacktestError).code).toBe(BACKTEST_ERROR_CODES.JSON_NUMBER_AMOUNT)
    }
  })

  it('rejects negative amount strings', () => {
    const input = buildSyntheticSmallInput()
    input.offers[0].pricePoints = '-1'
    try {
      parseJson(input)
      throw new Error('expected negative amount rejection')
    } catch (error) {
      expect((error as BacktestError).code).toBe(BACKTEST_ERROR_CODES.NEGATIVE_AMOUNT)
    }
  })

  it('rejects non-decimal amount strings', () => {
    const input = buildSyntheticSmallInput()
    input.offers[0].pricePoints = '12.5'
    try {
      parseJson(input)
    } catch (error) {
      expect((error as BacktestError).code).toBe(BACKTEST_ERROR_CODES.NON_DECIMAL_AMOUNT)
    }
    input.offers[0].pricePoints = '01'
    try {
      parseJson(input)
    } catch (error) {
      expect((error as BacktestError).code).toBe(BACKTEST_ERROR_CODES.NON_DECIMAL_AMOUNT)
    }
  })

  it('rejects an unknown schemaVersion', () => {
    const input = { ...buildSyntheticSmallInput(), schemaVersion: 99 }
    try {
      parseJson(input)
    } catch (error) {
      expect((error as BacktestError).code).toBe(BACKTEST_ERROR_CODES.UNKNOWN_SCHEMA_VERSION)
    }
  })

  it('rejects duplicate refs', () => {
    const input = buildSyntheticSmallInput()
    input.offers[1].offerRef = input.offers[0].offerRef
    try {
      parseJson(input)
    } catch (error) {
      expect((error as BacktestError).code).toBe(BACKTEST_ERROR_CODES.DUPLICATE_REF)
      expect(String((error as BacktestError).message)).not.toContain(input.offers[0].offerRef)
    }
  })

  it('rejects an order that references a missing offer', () => {
    const input = buildSyntheticSmallInput()
    input.orders[0].offerRef = syntheticRef('missing-offer')
    try {
      parseJson(input)
    } catch (error) {
      expect((error as BacktestError).code).toBe(BACKTEST_ERROR_CODES.ORPHAN_OFFER_REF)
    }
  })

  it('rejects a monthly row that references a missing account', () => {
    const input = buildSyntheticSmallInput()
    input.monthlyActivity[0].accountRef = syntheticRef('missing-account')
    try {
      parseJson(input)
    } catch (error) {
      expect((error as BacktestError).code).toBe(BACKTEST_ERROR_CODES.ORPHAN_ACCOUNT_REF)
    }
  })

  it('rejects an invalid period', () => {
    const input = buildSyntheticSmallInput()
    input.period.to = input.period.from
    try {
      parseJson(input)
    } catch (error) {
      expect((error as BacktestError).code).toBe(BACKTEST_ERROR_CODES.INVALID_PERIOD)
    }
  })

  it('rejects impossible calendar dates such as 2026-02-31', () => {
    const input = buildSyntheticSmallInput()
    input.period.from = '2026-02-31T00:00:00.000Z'
    try {
      parseJson(input)
      throw new Error('expected calendar rejection')
    } catch (error) {
      expect((error as BacktestError).code).toBe(BACKTEST_ERROR_CODES.INVALID_PERIOD)
    }
  })

  it('rejects database-style incremental identifiers', () => {
    const input = buildSyntheticSmallInput()
    input.offers[0].offerRef = '42'
    try {
      parseJson(input)
    } catch (error) {
      expect((error as BacktestError).code).toBe(BACKTEST_ERROR_CODES.IDENTIFIER_NOT_PSEUDONYMOUS)
    }
  })

  it('rejects input that exceeds the row limit', () => {
    const input = buildSyntheticSmallInput()
    const extra = Array.from({ length: INPUT_LIMITS.maxOffers + 1 }, (_, index) => ({
      offerRef: syntheticRef(`overflow-offer-${index}`),
      category: 'subscription',
      pricePoints: '100',
    }))
    input.offers = extra
    try {
      parseJson(input)
    } catch (error) {
      expect((error as BacktestError).code).toBe(BACKTEST_ERROR_CODES.TOO_MANY_ROWS)
    }
  })

  it('rejects a file that exceeds the size limit', () => {
    const directory = mkdtempSync(join(tmpdir(), 'd02-size-'))
    const path = join(directory, 'too-large.json')
    writeFileSync(path, 'x'.repeat(INPUT_LIMITS.maxFileBytes + 1))
    try {
      readAndParseInputFile(path)
      throw new Error('expected size rejection')
    } catch (error) {
      expect((error as BacktestError).code).toBe(BACKTEST_ERROR_CODES.FILE_TOO_LARGE)
    }
  })

  it('hashes the exact input bytes', () => {
    const raw = `${JSON.stringify(buildSyntheticSmallInput())}\n`
    const expected = createHash('sha256').update(raw).digest('hex')
    const parsed = parseBacktestInput(raw, hashBufferSha256(Buffer.from(raw)), Buffer.byteLength(raw))
    expect(parsed.rawSha256).toBe(expected)
  })
})
