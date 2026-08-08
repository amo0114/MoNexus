import { describe, expect, it } from 'vitest'
import {
  generateDefaultNickname,
  isGeneratedDefaultNickname,
  normalizeUserNickname,
} from '../lib/defaultNickname.js'

describe('defaultNickname', () => {
  it('generates mn_ + 8 safe alphabet chars', () => {
    for (let i = 0; i < 20; i += 1) {
      const n = generateDefaultNickname()
      expect(n.startsWith('mn_')).toBe(true)
      expect(n.length).toBe(11)
      expect(isGeneratedDefaultNickname(n)).toBe(true)
      expect(n).toMatch(/^mn_[2-9A-HJ-NP-Z]{8}$/)
    }
  })

  it('normalizes user nicknames', () => {
    expect(normalizeUserNickname('  小明  ')).toBe('小明')
    expect(normalizeUserNickname('')).toBeNull()
    expect(normalizeUserNickname('   ')).toBeNull()
    expect(() => normalizeUserNickname('x'.repeat(21))).toThrow('NICKNAME_TOO_LONG')
  })
})
