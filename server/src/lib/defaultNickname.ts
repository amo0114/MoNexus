import { randomInt } from 'node:crypto'

/**
 * 默认昵称:品牌前缀 + 规范后缀(类似淘宝 tb_xxx)。
 * - 前缀固定 `mn_`(MoNexus)
 * - 后缀 8 位:去掉易混字符 0/O/1/I 的大写字母+数字
 * - 全小写存储/展示前缀,后缀大写便于辨认(总长 3+8=11 ≤ 20)
 */
export const DEFAULT_NICKNAME_PREFIX = 'mn_'
/** 无 0/O/1/I,降低复制/口述混淆 */
export const DEFAULT_NICKNAME_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'
export const DEFAULT_NICKNAME_SUFFIX_LEN = 8

const GENERATED_RE = /^mn_[2-9A-HJ-NP-Z]{8}$/

export function isGeneratedDefaultNickname(nickname: string): boolean {
  return GENERATED_RE.test(nickname.trim())
}

export function generateDefaultNicknameSuffix(length = DEFAULT_NICKNAME_SUFFIX_LEN): string {
  let out = ''
  for (let i = 0; i < length; i += 1) {
    out += DEFAULT_NICKNAME_ALPHABET[randomInt(DEFAULT_NICKNAME_ALPHABET.length)]
  }
  return out
}

export function generateDefaultNickname(): string {
  return `${DEFAULT_NICKNAME_PREFIX}${generateDefaultNicknameSuffix()}`
}

/** Validate user-chosen nickname (1–20 chars after trim). */
export function normalizeUserNickname(raw: string | null | undefined): string | null {
  if (raw == null) return null
  const t = String(raw).trim()
  if (!t) return null
  if (t.length > 20) {
    throw new Error('NICKNAME_TOO_LONG')
  }
  // Disallow control chars / pure whitespace already trimmed
  if (/[\u0000-\u001f\u007f]/.test(t)) {
    throw new Error('NICKNAME_INVALID')
  }
  return t
}