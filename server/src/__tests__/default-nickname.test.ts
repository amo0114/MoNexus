import { describe, expect, it } from 'vitest'
import {
  generateDefaultNickname,
  defaultNicknameForUser,
  resolveUserNickname,
  normalizeUserNickname,
} from '../lib/defaultNickname.js'

describe('defaultNickname', () => {
  it('generates readable Chinese nicknames within the profile limit', () => {
    for (let i = 0; i < 20; i += 1) {
      const n = generateDefaultNickname()
      expect(n).toMatch(/^[\u4e00-\u9fff]+$/)
      expect(n.length).toBeLessThanOrEqual(20)
    }
  })

  it('keeps the v1 fallback stable and preserves every saved name, including the old format', () => {
    expect(defaultNicknameForUser(1)).toBe('爱喝茶的小军师')
    expect(defaultNicknameForUser(334)).toBe('追风的桃园客')
    expect(resolveUserNickname({ id: 1, nickname: null })).toBe('爱喝茶的小军师')
    expect(resolveUserNickname({ id: 1, nickname: '   ' })).toBe('爱喝茶的小军师')
    expect(resolveUserNickname({ id: 1, nickname: '  小明  ' })).toBe('小明')
    expect(resolveUserNickname({ id: 1, nickname: 'mn_23456789' })).toBe('mn_23456789')
    expect(() => defaultNicknameForUser(0)).toThrow('INVALID_USER_ID')
  })

  it('normalizes user nicknames', () => {
    expect(normalizeUserNickname('  小明  ')).toBe('小明')
    expect(normalizeUserNickname('')).toBeNull()
    expect(normalizeUserNickname('   ')).toBeNull()
    expect(() => normalizeUserNickname('x'.repeat(21))).toThrow('NICKNAME_TOO_LONG')
  })
})
