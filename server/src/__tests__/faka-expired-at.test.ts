import { describe, expect, it } from 'vitest'
import { parseFakaExpiredAt } from '../lib/fakaBridge/expiredAt.js'

describe('parseFakaExpiredAt', () => {
  it('parses unix seconds from Xboard user.expired_at', () => {
    const sec = 1791244800 // ~2026-10-06 UTC-ish
    const d = parseFakaExpiredAt(sec)
    expect(d).not.toBeNull()
    expect(d!.getTime()).toBe(sec * 1000)
  })

  it('accepts numeric strings', () => {
    expect(parseFakaExpiredAt('1791244800')!.getTime()).toBe(1791244800 * 1000)
  })

  it('treats large values as milliseconds', () => {
    const ms = 1791244800_000
    expect(parseFakaExpiredAt(ms)!.getTime()).toBe(ms)
  })

  it('rejects null / empty / garbage', () => {
    expect(parseFakaExpiredAt(null)).toBeNull()
    expect(parseFakaExpiredAt(undefined)).toBeNull()
    expect(parseFakaExpiredAt('')).toBeNull()
    expect(parseFakaExpiredAt('not-a-date')).toBeNull()
    expect(parseFakaExpiredAt(0)).toBeNull()
    expect(parseFakaExpiredAt(-1)).toBeNull()
  })
})
